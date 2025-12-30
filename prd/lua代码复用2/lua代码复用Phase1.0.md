# PRD: GroupMQ Lua 脚本模块化重构方案 (Phase 1)

## 1. 背景与目的

当前 GroupMQ 的 Lua 脚本（特别是 `complete-*.lua` 和 `reserve-*.lua` 系列）存在大量重复的内联逻辑。这导致维护困难，且容易在不同脚本间引入不一致的 Bug。
本次重构的目的是**借鉴 Bull 的设计模式**，将通用的业务逻辑提取为独立的 `includes` 模块，实现“组合式编程”，降低主脚本的复杂度，提升代码复用率。

## 2. 重构范围

本次重构主要针对以下核心业务逻辑进行模块化提取：

1.  **安全校验**：Job Token 的验证。
2.  **状态管理**：从 Active 列表中移除任务。
3.  **Flow 逻辑**：父子任务流（Parent Flow）的更新与晋升。
4.  **生命周期**：空群组的清理逻辑。

涉及修改的主脚本文件：

- `complete-with-metadata.lua`
- `complete-and-reserve-next-with-metadata.lua`
- `dead-letter.lua`
- `remove.lua` (部分涉及)

## 3. 新增模块定义 (Implementation Details)

请在 `includes/` 目录下创建以下新文件，并实现对应逻辑。

### 3.1. 安全校验模块

**文件路径**: `includes/security/verify-token.lua`
**功能描述**: 验证传入的 Token 是否与当前 Processing 锁中的 Token 一致。
**逻辑伪代码**:

```lua
-- 参数: ns, jobId, token
-- 逻辑:
-- 1. 构造 procKey (ns .. ":processing:" .. jobId)
-- 2. HGET 获取 storedToken
-- 3. 如果 storedToken 存在且等于传入 token，返回 true；否则返回 false。
```

### 3.2. 活跃列表管理模块

**文件路径**: `includes/group-state/remove-job-from-active.lua`
**功能描述**: 从群组的 Active 列表中移除指定 Job，并处理非头部移除的边缘情况。
**逻辑伪代码**:

```lua
-- 参数: ns, groupId, jobId
-- 逻辑:
-- 1. 构造 activeKey
-- 2. LINDEX 获取列表头部元素
-- 3. 如果头部元素 == jobId，执行 LPOP
-- 4. 否则（Race condition），执行 LREM (count 1)
-- 5. 返回: 无需特定返回值
```

### 3.3. Flow 逻辑模块 (核心重构)

**文件路径**: `includes/flow/update-parent-flow.lua`
**依赖**: 需要引入 `includes/group-lifecycle/update-group-ready-limited-state`
**功能描述**: 当子任务结束时，更新父任务的进度，并在父任务所有子项完成时将其晋升为 Waiting。
**逻辑伪代码**:

```lua
-- 参数: ns, parentId, childId, status, resultOrError, timestamp
-- 逻辑:
-- 1. 构造 parentKey, flowResultsKey
-- 2. HSET flowResultsKey, field=childId, value=JSON({status, data})
-- 3. HINCRBY parentKey "flowRemaining" -1
-- 4. 如果 remaining <= 0:
--    a. 检查 parentStatus 是否为 "waiting-children"
--    b. 如果是，HSET parentStatus = "waiting"
--    c. 获取 parentGroupId, parentScore
--    d. ZADD parentId 到父群组 ZSET
--    e. 调用 updateGroupReadyLimitedState 检查父群组状态
```

### 3.4. 群组清理模块

**文件路径**: `includes/group-lifecycle/cleanup-group-if-empty.lua`
**功能描述**: 检查群组是否为空（无任务），如果为空则清理元数据；如果不为空则从 Ready/Limited 队列移除（用于 Complete 场景下的后处理）。
**逻辑伪代码**:

```lua
-- 参数: ns, groupId
-- 逻辑:
-- 1. 获取群组剩余任务数 (ZSIZE gZ)
-- 2. 获取群组 meta count (remainingJobs)
-- 3. 如果 jobCount == 0 且 remainingJobs <= 0:
--    a. DEL gZ, groupActive, groupMeta, groupBuffer
--    b. SREM groups, ZREM ready, ZREM limited, ZREM buffering
--    c. 返回 "cleaned"
-- 4. 否则:
--    a. ZREM ready, ZREM limited (暂时移除，由后续逻辑决定是否加回)
--    b. 返回 "not-empty"
```

## 4. 现有脚本修改计划

请使用 `@include` 引入上述新模块，并替换原有的内联代码。

### 4.1. 重构 `complete-with-metadata.lua`

- **引入**:
  - `includes/security/verify-token`
  - `includes/group-state/remove-job-from-active`
  - `includes/group-lifecycle/cleanup-group-if-empty`
  - `includes/flow/update-parent-flow`
- **替换**:
  - 替换开头的 Token 校验逻辑为 `verifyToken(...)`。
  - 替换 Active List 的 `LPOP/LREM` 逻辑为 `removeJobFromActive(...)`。
  - 替换 `if jobCount == 0 then ... else ... end` 的大段清理逻辑，使用 `cleanupGroupIfEmpty` 配合 `updateGroupReadyLimitedState`。
  - 替换 `[PHASE 3 MODIFICATION]` 标记内的所有 Parent Flow 更新代码为 `updateParentFlow(...)`。

### 4.2. 重构 `complete-and-reserve-next-with-metadata.lua`

- **操作**: 同上，替换 Token 校验、Active 移除、Parent Flow 更新逻辑。
- **注意**: 此脚本有特殊的 "reserve next" 逻辑，清理 Group 的部分需要小心，不要误删了即将被 Reserve 的 Next Job 所在的 Group（虽然通常是同一个 Group，但要注意逻辑顺序）。

### 4.3. 重构 `dead-letter.lua`

- **操作**:
  - 引入 `verify-token` 替换校验逻辑。
  - 引入 `remove-job-from-active` 替换 `LREM` 逻辑。

## 5. 预期效果展示 (Targeted Outcome)

重构后，`complete-with-metadata.lua` 的主逻辑应类似以下伪代码，逻辑更清晰，代码量更少：

```lua
--- @include "includes/security/verify-token"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/flow/update-parent-flow"
--- @include "includes/job-lifecycle/record-job-finalization"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/group-lifecycle/cleanup-group-if-empty"
--- @include "includes/group-status/get-group-head-job"

local ns = KEYS[1]
-- ... 参数获取 ...

-- 1. 安全校验 (封装)
if not verifyToken(ns, jobId, token) then return 0 end

-- 2. 状态原子性变更 (部分逻辑保留在主脚本或进一步封装)
redis.call("HSET", jobKey, "status", "completing")
redis.call("DEL", procKey)
redis.call("ZREM", processingKey, jobId)

-- 3. 活跃列表维护 (封装)
removeJobFromActive(ns, gid, jobId)

-- 4. 尝试更新组状态 (封装)
local nextJobId = getGroupHeadJob(ns, gid)
if nextJobId then
  -- 获取分数并更新状态
  local head = redis.call("ZRANGE", ns .. ":g:" .. gid, 0, 0, "WITHSCORES")
  local headScore = tonumber(head[2])
  updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, headScore)
else
  cleanupGroupIfEmpty(ns, gid)
end

-- 5. Flow 更新 (封装)
if parentId then
  updateParentFlow(ns, parentId, jobId, status, resultOrError, timestamp)
end

-- 6. 记录结果 (现有封装，很好)
recordJobFinalization(...)

return 1
```

## 6. 验收标准 (Success Criteria)

1.  **代码量减少**: 主脚本文件行数应显著减少。
2.  **功能一致性**: 重构后的脚本逻辑流程必须与原逻辑完全保持一致（特别是原子性操作顺序）。
3.  **模块独立性**: 新增的 `includes` 文件不包含具体的业务 ID 硬编码，保持通用性。
4.  **无语法错误**: Lua 脚本加载时无解析错误。

## 7. 执行提示

请按照上述 PRD 执行重构。

1.  首先，创建第 3 节中定义的所有 `includes/` 下的新 Lua 文件。
2.  然后，修改 `complete-with-metadata.lua`，使用 `@include` 引用新模块并删除冗余代码，使其结构接近第 5 节的伪代码示例。请确保保留原有的 Redis Key 定义和参数解析逻辑。
3.  接着，同样方式重构 `complete-and-reserve-next-with-metadata.lua` 和 `dead-letter.lua`。
4.  请展示重构后的文件内容。

