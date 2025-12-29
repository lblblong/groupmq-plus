# Lua逻辑复用代码优化 - 分阶段实施计划

## 1. 整体规划

本项目将分为 **3个Phase** 逐步实施代码逻辑复用优化，每个Phase都包含明确的可交付成果和测试验证。

### 1.1 实施时间线

```
┌─────────────────┬─────────────────┬─────────────────┬──────────────┐
│    Phase 1      │    Phase 2      │    Phase 3      │   评审发布   │
│   (基础提取)     │   (核心优化)     │   (完善收尾)     │              │
│  高优先级函数   │  中等优先级函数  │  低优先级函数    │ 全量测试 → GO │
│   4个函数       │   3个函数        │   2个函数        │              │
└─────────────────┴─────────────────┴─────────────────┴──────────────┘
    1-2周           2-3周             1周              1周
```

### 1.2 实施关键成果

| Phase | 函数数 | 代码减少 | 风险等级 | 验证范围 |
|-------|--------|---------|---------|---------|
| 1 | 4个 | ~80行 | 低-中 | 6个主脚本 |
| 2 | 3个 | ~40行 | 低-中 | 3-6个主脚本 |
| 3 | 2个 | ~10行 | 低 | 6个主脚本 |
| **总计** | **9个** | **~130行** | **中** | **所有相关脚本** |

---

## 2. Phase 1：基础提取 - 高优先级函数（第1-2周）

### 2.1 Phase 1 目标

实现4个高优先级、高收益的函数提取，建立标准的提取模式和验证流程。

### 2.2 Phase 1 包含的函数

#### 2.2.1 函数1：verifyJobToken() - Token验证
**优先级**：P0 - 立即执行
**复杂度**：⭐☆☆ (低)
**风险**：⭐☆☆ (低)
**代码减少**：4-6行 × 6处 = 24-36行

**新建文件**：`src/lua/includes/token-verify/verify-job-token.lua`

```lua
-- 说明: 验证 Job 的 Token 是否匹配
-- 用途: 防止多个 worker 同时处理同一个 job
-- 参数:
--   ns: namespace 前缀
--   jobId: 要验证的 job ID
--   token: 预期的 token 值
-- 返回: (isValid, errorCode)
--   isValid: boolean, true 表示 token 有效
--   errorCode: 错误代码，-2 表示 token 不匹配，-3 表示 job 不在处理中

local function verifyJobToken(ns, jobId, token)
  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  if not storedToken or storedToken == false then
    -- Job not in processing
    return false, -3
  end

  if storedToken ~= token then
    -- Token mismatch
    return false, -2
  end

  return true, 0
end

return verifyJobToken
```

**应用到的文件**（6个）：
1. `src/lua/complete-with-metadata.lua` - 第45-52行
2. `src/lua/dead-letter.lua` - 第15-26行
3. `src/lua/record-job-result.lua` - 第21-27行
4. `src/lua/includes/retry-handling/handle-job-retry-with-backoff.lua` - 第13-23行
5. `src/lua/dead-letter.lua` - 另一处
6. `src/lua/includes/job-lifecycle/record-job-finalization.lua` - 如有

**更新脚本示例**（以 complete-with-metadata.lua 为例）：
```lua
@include "../includes/token-verify/verify-job-token.lua"

-- 原来的 5-8 行代码
-- if storedToken and storedToken ~= token then
--   return -2
-- end

-- 改为 2 行代码
local tokenValid, errorCode = verifyJobToken(ns, jobId, token)
if not tokenValid then
  return errorCode
end
```

**验证步骤**：
- [ ] 编写 `verify-job-token.lua`
- [ ] 在 `complete-with-metadata.lua` 中应用并验证
- [ ] 在 `dead-letter.lua` 中应用并验证
- [ ] 在 `record-job-result.lua` 中应用并验证
- [ ] 在 `handle-job-retry-with-backoff.lua` 中应用并验证
- [ ] 运行单元测试验证 Token 验证逻辑
- [ ] 验证错误返回码一致性

---

#### 2.2.2 函数2：cleanupGroupIfEmpty() - 组清理
**优先级**：P0 - 立即执行
**复杂度**：⭐⭐☆ (中)
**风险**：⭐⭐☆ (中)
**代码减少**：10-30行 × 6处 = 60-180行

**新建文件**：`src/lua/includes/group-lifecycle/cleanup-group-if-empty.lua`

```lua
-- 说明: 检查并清理空的 group
-- 用途: 当 group 中的所有 job 完成/失败后，清理 group 相关的所有数据
-- 参数:
--   ns: namespace 前缀
--   groupId: group ID
--   readyKey: ready groups 有序集合键
--   limitedKey: limited groups 有序集合键
-- 返回: cleaned (boolean)
--   true: group 已被清理
--   false: group 仍有 job，未清理

local function cleanupGroupIfEmpty(ns, groupId, readyKey, limitedKey)
  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"

  -- 检查当前 group 中的 job 数量
  local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count"))

  if not remainingJobs or remainingJobs <= 0 then
    -- Group 为空，执行清理
    local gZ = ns .. ":g:" .. groupId
    local gactive = ns .. ":g:" .. groupId .. ":active"

    redis.call("DEL", gZ)                          -- 删除 group 等待队列
    redis.call("DEL", groupMetaKey)               -- 删除 group 元数据
    redis.call("DEL", gactive)                    -- 删除 group active 列表
    redis.call("SREM", ns .. ":groups", groupId)  -- 从全局 groups 集合移除
    redis.call("ZREM", readyKey, groupId)         -- 从 ready 集合移除
    redis.call("ZREM", limitedKey, groupId)       -- 从 limited 集合移除

    return true  -- 已清理
  else
    return false  -- group 仍有 job
  end
end

return cleanupGroupIfEmpty
```

**应用到的文件**（6个）：
1. `src/lua/complete.lua` - 第26-41行
2. `src/lua/complete-with-metadata.lua` - 第80-114行
3. `src/lua/dead-letter.lua` - 第50-67行
4. `src/lua/includes/job-lifecycle/delete-job-completely.lua` - 第51-78行
5. `src/lua/clean-status.lua` - 第49-70行
6. `src/lua/complete-and-reserve-next-with-metadata.lua` - 第205-216行

**更新脚本示例**（以 complete.lua 为例）：
```lua
@include "../includes/group-lifecycle/cleanup-group-if-empty.lua"

-- 原来的 15 行清理代码
-- if remainingJobs <= 0 then
--   redis.call("DEL", gZ)
--   ...
-- end

-- 改为 1-2 行代码
local cleaned = cleanupGroupIfEmpty(ns, groupId, readyKey, limitedKey)
```

**验证步骤**：
- [ ] 编写 `cleanup-group-if-empty.lua`
- [ ] 验证在 empty group 时正确清理所有键
- [ ] 验证在 non-empty group 时不进行清理
- [ ] 在 `complete.lua` 中应用并验证
- [ ] 在 `complete-with-metadata.lua` 中应用并验证
- [ ] 在 `dead-letter.lua` 中应用并验证
- [ ] 在 `delete-job-completely.lua` 中应用并验证
- [ ] 在 `clean-status.lua` 中应用并验证
- [ ] 在 `complete-and-reserve-next-with-metadata.lua` 中应用并验证
- [ ] 验证 group 状态转换的一致性

---

#### 2.2.3 函数3：decrementGroupJobCount() - 递减计数
**优先级**：P0 - 立即执行
**复杂度**：⭐☆☆ (低)
**风险**：⭐☆☆ (低)
**代码减少**：2-3行 × 6处 = 12-18行

**新建文件**：`src/lua/includes/group-status/decrement-group-job-count.lua`

```lua
-- 说明: 递减 group 中的 job 计数
-- 用途: 当 job 完成/失败/删除时，更新 group 的 job 计数
-- 参数:
--   ns: namespace 前缀
--   groupId: group ID
-- 返回: remainingJobs (number)
--   group 中剩余的 job 数量

local function decrementGroupJobCount(ns, groupId)
  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
  return remainingJobs or 0
end

return decrementGroupJobCount
```

**应用到的文件**（6个）：
1. `src/lua/complete.lua`
2. `src/lua/complete-with-metadata.lua`
3. `src/lua/dead-letter.lua`
4. `src/lua/includes/job-lifecycle/delete-job-completely.lua`
5. `src/lua/clean-status.lua`
6. `src/lua/complete-and-reserve-next-with-metadata.lua`

**更新脚本示例**：
```lua
@include "../includes/group-status/decrement-group-job-count.lua"

-- 原来的 2-3 行代码
-- local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
-- local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

-- 改为 1 行代码
local remainingJobs = decrementGroupJobCount(ns, groupId)
```

**验证步骤**：
- [ ] 编写 `decrement-group-job-count.lua`
- [ ] 验证计数正确递减
- [ ] 在所有6个文件中应用并验证
- [ ] 验证计数不会低于0

---

#### 2.2.4 函数4：removeJobFromActiveList() - 从Active列表移除
**优先级**：P0 - 立即执行
**复杂度**：⭐☆☆ (低)
**风险**：⭐☆☆ (低)
**代码减少**：1-2行 × 6处 = 6-12行

**新建文件**：`src/lua/includes/job-lifecycle/remove-job-from-active-list.lua`

```lua
-- 说明: 从 group 的 active 列表中移除 job
-- 用途: 当 job 完成/失败/删除时，将其从 active 列表移除
-- 参数:
--   ns: namespace 前缀
--   groupId: group ID
--   jobId: job ID
-- 返回: removed (number)
--   1 表示成功移除，0 表示未找到该 job

local function removeJobFromActiveList(ns, groupId, jobId)
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LREM", groupActiveKey, 1, jobId)
end

return removeJobFromActiveList
```

**应用到的文件**（6个）：
1. `src/lua/complete.lua`
2. `src/lua/complete-with-metadata.lua`
3. `src/lua/dead-letter.lua`
4. `src/lua/includes/retry-handling/handle-job-retry-with-backoff.lua`
5. `src/lua/includes/job-lifecycle/delete-job-completely.lua`
6. 等

**更新脚本示例**：
```lua
@include "../includes/job-lifecycle/remove-job-from-active-list.lua"

-- 原来的代码
-- redis.call("LREM", groupActiveKey, 1, jobId)

-- 改为
removeJobFromActiveList(ns, groupId, jobId)
```

**验证步骤**：
- [ ] 编写 `remove-job-from-active-list.lua`
- [ ] 在所有6个文件中应用并验证
- [ ] 验证 job 确实从 active 列表中移除

---

### 2.3 Phase 1 验证与测试

#### 2.3.1 单元测试
为每个新建的函数编写单元测试：

```lua
-- 测试用例示例
local tests = {
  -- verifyJobToken
  { name = "Token valid", expected = true },
  { name = "Token mismatch", expected = false },
  { name = "Job not in processing", expected = false },

  -- cleanupGroupIfEmpty
  { name = "Empty group cleanup", expected = true },
  { name = "Non-empty group", expected = false },

  -- decrementGroupJobCount
  { name = "Decrement from 3 to 2", expected = 2 },
  { name = "Decrement from 1 to 0", expected = 0 },

  -- removeJobFromActiveList
  { name = "Job found and removed", expected = 1 },
  { name = "Job not found", expected = 0 },
}
```

#### 2.3.2 集成测试
验证优化后的脚本在实际场景中的运行：

- [ ] 测试 `complete.lua` - 确保 job 完成后正确清理
- [ ] 测试 `complete-with-metadata.lua` - 确保 metadata 同步
- [ ] 测试 `dead-letter.lua` - 确保失败 job 处理正确
- [ ] 测试 group 生命周期完整流程
- [ ] 测试 token 验证失败的处理流程

#### 2.3.3 回归测试
运行现有的所有测试用例，确保没有破坏原有功能：
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 性能没有下降

### 2.4 Phase 1 可交付成果

| 文件 | 类型 | 说明 |
|------|------|------|
| `includes/token-verify/verify-job-token.lua` | 新增 | Token 验证函数 |
| `includes/group-lifecycle/cleanup-group-if-empty.lua` | 新增 | 组清理函数 |
| `includes/group-status/decrement-group-job-count.lua` | 新增 | 计数递减函数 |
| `includes/job-lifecycle/remove-job-from-active-list.lua` | 新增 | Active列表移除函数 |
| `complete.lua` | 修改 | 应用新函数 |
| `complete-with-metadata.lua` | 修改 | 应用新函数 |
| `dead-letter.lua` | 修改 | 应用新函数 |
| `delete-job-completely.lua` | 修改 | 应用新函数 |
| `clean-status.lua` | 修改 | 应用新函数 |
| `complete-and-reserve-next-with-metadata.lua` | 修改 | 应用新函数 |
| `handle-job-retry-with-backoff.lua` | 修改 | 应用新函数 |
| `includes/README.md` | 修改 | 添加新函数文档 |

### 2.5 Phase 1 风险及缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Token验证逻辑不完整 | 低 | 中 | 详细测试各种token状态 |
| Group清理遗漏某个键 | 中 | 高 | 列举所有清理项，逐一验证 |
| 计数递减计算错误 | 低 | 高 | 边界值测试 |
| 性能下降 | 低 | 中 | 基准测试对比 |

---

## 3. Phase 2：核心优化 - 中等优先级函数（第2-3周）

### 3.1 Phase 2 目标

实现3个中等优先级的函数提取，重点是流处理和时间序列的核心逻辑。

### 3.2 Phase 2 包含的函数

#### 3.2.1 函数5：getCurrentTimeMs() - 获取当前时间
**优先级**：P1
**复杂度**：⭐☆☆ (低)
**风险**：⭐☆☆ (低)
**代码减少**：2行 × 6处 = 12行

**新建文件**：`src/lua/includes/time-helpers/get-current-time-ms.lua`

```lua
-- 说明: 获取当前时间戳（毫秒）
-- 用途: 统一时间戳获取方式，确保所有操作使用一致的时间基准
-- 参数: 无
-- 返回: currentTimeMs (number)
--   当前时间戳，单位毫秒

local function getCurrentTimeMs()
  local timeResult = redis.call("TIME")
  local seconds = tonumber(timeResult[1])
  local microseconds = tonumber(timeResult[2])
  return seconds * 1000 + math.floor(microseconds / 1000)
end

return getCurrentTimeMs
```

**应用到的文件**：
1. `src/lua/enqueue.lua`
2. `src/lua/enqueue-batch.lua`
3. `src/lua/record-job-result.lua`
4. `src/lua/complete-with-metadata.lua`
5. `src/lua/complete-and-reserve-next-with-metadata.lua`
6. `src/lua/heartbeat.lua`

**验证步骤**：
- [ ] 编写 `get-current-time-ms.lua`
- [ ] 验证时间戳计算准确
- [ ] 在所有相关文件中应用
- [ ] 验证时间单调性（后续调用始终 >= 前一个）

---

#### 3.2.2 函数6：generateJobScore() - 生成Job排序分数
**优先级**：P1
**复杂度**：⭐⭐☆ (中)
**风险**：⭐⭐☆ (中)
**代码减少**：5行 × 5处 = 25行

**新建文件**：`src/lua/includes/sequence-helpers/generate-job-score.lua`

```lua
-- 说明: 为 job 生成排序分数
-- 用途: 确保 job 按照创建时间和序列号正确排序
-- 参数:
--   ns: namespace 前缀
--   orderMs: 排序时间戳（毫秒）
-- 返回: score (number)
--   job 的排序分数，用于有序集合排序

local function generateJobScore(ns, orderMs)
  local baseEpoch = 1704067200000  -- 2024-01-01 00:00:00

  if orderMs < baseEpoch then
    orderMs = baseEpoch
  end

  local relativeMs = orderMs - baseEpoch
  local daysSinceEpoch = math.floor(relativeMs / 86400000)

  local seqKey = ns .. ":seq:" .. daysSinceEpoch
  local seq = redis.call("INCR", seqKey)

  -- 设置过期时间，确保序列号不会无限增长
  redis.call("EXPIRE", seqKey, 86400)  -- 24小时过期

  -- Score = (距离基准的毫秒) * 1000 + 序列号
  local score = relativeMs * 1000 + seq

  return score
end

return generateJobScore
```

**应用到的文件**：
1. `src/lua/enqueue.lua` - 第103-110行
2. `src/lua/enqueue-batch.lua` - 第23-48行
3. `src/lua/enqueue-flow.lua` - 第51-54, 107-111行

**验证步骤**：
- [ ] 编写 `generate-job-score.lua`
- [ ] 验证 score 的单调递增性质
- [ ] 验证序列号的准确性
- [ ] 在所有相关文件中应用
- [ ] 验证不同时间戳的 job 排序正确

---

#### 3.2.3 函数7：recordFlowChildResult() - 记录Flow子结果
**优先级**：P1
**复杂度**：⭐☆☆ (低)
**风险**：⭐☆☆ (低)
**代码减少**：3-4行 × 3处 = 9-12行

**新建文件**：`src/lua/includes/flow-handling/record-flow-child-result.lua`

```lua
-- 说明: 记录 Flow 中子任务的执行结果
-- 用途: 保存子任务的成功/失败结果，供 parent job 查询
-- 参数:
--   ns: namespace 前缀
--   parentId: parent job ID
--   jobId: child job ID
--   status: 结果状态（"success" 或 "fail"）
--   resultOrError: 结果数据或错误信息
-- 返回: 无

local function recordFlowChildResult(ns, parentId, jobId, status, resultOrError)
  local flowResultsKey = ns .. ":flow:results:" .. parentId

  local flowEntry = cjson.encode({
    status = status,
    data = resultOrError
  })

  redis.call("HSET", flowResultsKey, jobId, flowEntry)
end

return recordFlowChildResult
```

**应用到的文件**：
1. `src/lua/record-job-result.lua` - 第59-63行
2. `src/lua/complete-with-metadata.lua` - 第73-77行
3. `src/lua/complete-and-reserve-next-with-metadata.lua` - 第73-77行

**验证步骤**：
- [ ] 编写 `record-flow-child-result.lua`
- [ ] 验证结果正确编码为 JSON
- [ ] 在所有相关文件中应用
- [ ] 验证结果能正确被 parent job 查询

---

### 3.3 Phase 2 验证与测试

#### 3.3.1 单元测试
- [ ] 验证 `getCurrentTimeMs()` 的时间精度
- [ ] 验证 `generateJobScore()` 的唯一性和单调性
- [ ] 验证 `recordFlowChildResult()` 的编码

#### 3.3.2 集成测试
- [ ] 测试 enqueue 流程中的时间戳和 score
- [ ] 测试 Flow child result 的保存和查询
- [ ] 测试时间戳在分布式场景中的一致性

### 3.4 Phase 2 可交付成果

| 文件 | 类型 | 说明 |
|------|------|------|
| `includes/time-helpers/get-current-time-ms.lua` | 新增 | 时间戳获取函数 |
| `includes/sequence-helpers/generate-job-score.lua` | 新增 | Job排序分数生成 |
| `includes/flow-handling/record-flow-child-result.lua` | 新增 | Flow子结果记录 |
| `enqueue.lua` | 修改 | 应用新函数 |
| `enqueue-batch.lua` | 修改 | 应用新函数 |
| `enqueue-flow.lua` | 修改 | 应用新函数 |
| `record-job-result.lua` | 修改 | 应用新函数 |
| `complete-with-metadata.lua` | 修改 | 应用新函数 |
| `complete-and-reserve-next-with-metadata.lua` | 修改 | 应用新函数 |

---

## 4. Phase 3：完善收尾 - 低优先级函数（第3周）

### 4.1 Phase 3 目标

实现最后2个低优先级的函数提取，完成整个代码复用优化项目。

### 4.2 Phase 3 包含的函数

#### 4.2.1 函数8：promoteParentIfAllChildrenComplete() - Parent提升
**优先级**：P2
**复杂度**：⭐⭐⭐ (高)
**风险**：⭐⭐☆ (中-高)
**代码减少**：35-50行 × 4处 = 140-200行

**新建文件**：`src/lua/includes/flow-handling/promote-parent-if-all-children-complete.lua`

```lua
-- 说明: 当所有子任务完成时，提升 parent job
-- 用途: 处理 Flow 中当所有 child 任务完成后，恢复 parent job 的待处理状态
-- 参数:
--   ns: namespace 前缀
--   parentId: parent job ID
--   readyKey: ready groups 有序集合键
--   limitedKey: limited groups 有序集合键
-- 返回: promoted (boolean)
--   true 表示 parent 已被提升，false 表示未提升

local function promoteParentIfAllChildrenComplete(ns, parentId, readyKey, limitedKey)
  local parentKey = ns .. ":job:" .. parentId
  local parentStatus = redis.call("HGET", parentKey, "status")

  if parentStatus ~= "waiting-children" then
    return false
  end

  -- 获取剩余子任务数
  local remaining = tonumber(redis.call("HGET", parentKey, "flowRemaining")) or 0

  if remaining > 0 then
    return false  -- 还有子任务未完成
  end

  -- 所有子任务已完成，恢复 parent job
  redis.call("HSET", parentKey, "status", "waiting")

  local parentGroupId = redis.call("HGET", parentKey, "groupId")
  local parentScore = tonumber(redis.call("HGET", parentKey, "score"))

  if not parentScore then
    parentScore = tonumber(redis.call("TIME")[1]) * 1000
  end

  -- 将 parent 加入组的等待队列
  local pGZ = ns .. ":g:" .. parentGroupId
  redis.call("ZADD", pGZ, parentScore, parentId)
  redis.call("SADD", ns .. ":groups", parentGroupId)

  -- 更新 group 的 ready/limited 状态
  local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
  if pHead and #pHead >= 2 then
    local pHeadScore = tonumber(pHead[2])
    local pGroupActiveKey = ns .. ":g:" .. parentGroupId .. ":active"
    local pConfigKey = ns .. ":config:" .. parentGroupId
    local pLimit = tonumber(redis.call("HGET", pConfigKey, "concurrency")) or 1
    local pCurrentActive = redis.call("LLEN", pGroupActiveKey)

    if pCurrentActive >= pLimit then
      redis.call("ZREM", readyKey, parentGroupId)
      redis.call("ZADD", limitedKey, pHeadScore, parentGroupId)
    else
      redis.call("ZREM", limitedKey, parentGroupId)
      redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
    end
  end

  return true
end

return promoteParentIfAllChildrenComplete
```

**应用到的文件**：
1. `src/lua/record-job-result.lua` - 第68-104行
2. `src/lua/complete-with-metadata.lua` - 第132-164行
3. `src/lua/complete-and-reserve-next-with-metadata.lua` - 第83-109行
4. `src/lua/clean-status.lua` - 第93-127行

**验证步骤**：
- [ ] 编写 `promote-parent-if-all-children-complete.lua`
- [ ] 测试 parent 正确提升
- [ ] 测试 parent group 状态（ready/limited）的正确性
- [ ] 测试多个 child 完成后的状态转换
- [ ] 端到端测试完整的 Flow 流程

---

#### 4.2.2 函数9：handleChildJobDeletion() - Child删除处理
**优先级**：P2
**复杂度**：⭐⭐⭐ (高)
**风险**：⭐⭐☆ (中-高)
**代码减少**：40-60行 × 2处 = 80-120行

**新建文件**：`src/lua/includes/flow-handling/handle-child-job-deletion.lua`

```lua
-- 说明: 处理子任务被删除时的 parent 更新
-- 用途: 当 child job 被删除时，更新 parent 的子任务计数和状态
-- 参数:
--   ns: namespace 前缀
--   parentId: parent job ID
--   jobId: 被删除的 child job ID
--   readyKey: ready groups 有序集合键
--   limitedKey: limited groups 有序集合键
-- 返回: wasChild (boolean)
--   true 表示该 job 是某个 parent 的 child，false 表示不是

local function handleChildJobDeletion(ns, parentId, jobId, readyKey, limitedKey)
  if not parentId then
    return false
  end

  local parentKey = ns .. ":job:" .. parentId
  local parentChildrenKey = ns .. ":flow:children:" .. parentId

  -- 尝试从 children 集合中移除
  local removedFromSet = redis.call("SREM", parentChildrenKey, jobId)

  if removedFromSet == 0 then
    return false  -- job 不是该 parent 的 child
  end

  -- job 确实是该 parent 的 child，执行相关清理
  redis.call("HDEL", ns .. ":flow:results:" .. parentId, jobId)

  -- 更新 parent 的子任务计数
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)
  remaining = tonumber(remaining) or 0

  -- 如果所有子任务都已完成/删除，并且 parent 还在等待子任务，则提升 parent
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")

    if parentStatus == "waiting-children" then
      -- 恢复 parent 为 waiting 状态
      redis.call("HSET", parentKey, "status", "waiting")

      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))

      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end

      -- 将 parent 加入等待队列
      local pGZ = ns .. ":g:" .. parentGroupId
      redis.call("ZADD", pGZ, parentScore, parentId)
      redis.call("SADD", ns .. ":groups", parentGroupId)

      -- 更新 group 的 ready/limited 状态
      local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
      if pHead and #pHead >= 2 then
        local pHeadScore = tonumber(pHead[2])
        local pGroupActiveKey = ns .. ":g:" .. parentGroupId .. ":active"
        local pConfigKey = ns .. ":config:" .. parentGroupId
        local pLimit = tonumber(redis.call("HGET", pConfigKey, "concurrency")) or 1
        local pCurrentActive = redis.call("LLEN", pGroupActiveKey)

        if pCurrentActive >= pLimit then
          redis.call("ZREM", readyKey, parentGroupId)
          redis.call("ZADD", limitedKey, pHeadScore, parentGroupId)
        else
          redis.call("ZREM", limitedKey, parentGroupId)
          redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
        end
      end
    end
  end

  return true
end

return handleChildJobDeletion
```

**应用到的文件**：
1. `src/lua/includes/job-lifecycle/delete-job-completely.lua` - 第89-140行
2. `src/lua/clean-status.lua` - 第82-129行

**验证步骤**：
- [ ] 编写 `handle-child-job-deletion.lua`
- [ ] 测试 child 删除后正确更新 parent
- [ ] 测试 parent 状态转换正确性
- [ ] 测试多个 child 逐个删除的场景
- [ ] 端到端测试 Flow 中途删除 child 的流程

---

### 4.3 Phase 3 验证与测试

#### 4.3.1 单元测试
- [ ] 验证 `promoteParentIfAllChildrenComplete()` 的状态转换
- [ ] 验证 `handleChildJobDeletion()` 的 child 移除

#### 4.3.2 集成与回归测试
- [ ] 完整 Flow 流程测试（多个 child 的场景）
- [ ] Flow 中途 child 删除测试
- [ ] Flow parent 状态转换测试
- [ ] 所有之前的测试仍通过

### 4.4 Phase 3 可交付成果

| 文件 | 类型 | 说明 |
|------|------|------|
| `includes/flow-handling/promote-parent-if-all-children-complete.lua` | 新增 | Parent提升函数 |
| `includes/flow-handling/handle-child-job-deletion.lua` | 新增 | Child删除处理函数 |
| `record-job-result.lua` | 修改 | 应用新函数 |
| `complete-with-metadata.lua` | 修改 | 应用新函数 |
| `complete-and-reserve-next-with-metadata.lua` | 修改 | 应用新函数 |
| `clean-status.lua` | 修改 | 应用新函数 |
| `delete-job-completely.lua` | 修改 | 应用新函数 |

---

## 5. 最终发布阶段（第4周）

### 5.1 全量测试

在所有Phase完成后，进行完整的回归测试：

- [ ] 单元测试全部通过
- [ ] 集成测试全部通过
- [ ] 性能基准测试（确保无回退）
- [ ] 压力测试（高并发场景）
- [ ] 故障恢复测试

### 5.2 代码审查

- [ ] 所有新增函数进行代码审查
- [ ] 所有修改的脚本进行代码审查
- [ ] 验证代码规范一致性

### 5.3 文档更新

- [ ] 更新 `includes/README.md` 新增函数文档
- [ ] 更新主脚本的注释说明
- [ ] 编写迁移指南

### 5.4 发布

- [ ] 合并到 main 分支
- [ ] 部署到测试环境验证
- [ ] 部署到生产环境

---

## 6. 项目跟踪矩阵

### 6.1 Phase 1 跟踪

| 项目 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| verifyJobToken | ⏳ | 0% | 待开始 |
| cleanupGroupIfEmpty | ⏳ | 0% | 待开始 |
| decrementGroupJobCount | ⏳ | 0% | 待开始 |
| removeJobFromActiveList | ⏳ | 0% | 待开始 |
| 单元测试 | ⏳ | 0% | 待开始 |
| 集成测试 | ⏳ | 0% | 待开始 |

### 6.2 Phase 2 跟踪

| 项目 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| getCurrentTimeMs | ⏳ | 0% | 等待 Phase 1 完成 |
| generateJobScore | ⏳ | 0% | 等待 Phase 1 完成 |
| recordFlowChildResult | ⏳ | 0% | 等待 Phase 1 完成 |
| 单元测试 | ⏳ | 0% | 等待 Phase 1 完成 |
| 集成测试 | ⏳ | 0% | 等待 Phase 1 完成 |

### 6.3 Phase 3 跟踪

| 项目 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| promoteParentIfAllChildrenComplete | ⏳ | 0% | 等待 Phase 2 完成 |
| handleChildJobDeletion | ⏳ | 0% | 等待 Phase 2 完成 |
| 单元测试 | ⏳ | 0% | 等待 Phase 2 完成 |
| 集成测试 | ⏳ | 0% | 等待 Phase 2 完成 |

---

## 7. 风险管理

### 7.1 风险清单

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 提取函数遗漏边界情况 | 中 | 高 | 详细代码审查，边界值测试 |
| 应用函数时出现参数错误 | 中 | 中 | 自动化测试，单元测试覆盖 |
| 性能下降 | 低 | 高 | 基准测试对比，性能分析 |
| Flow 流程破坏 | 中 | 极高 | 端到端测试，逐步灰度发布 |
| 回滚困难 | 低 | 中 | 完整备份，清晰的版本管理 |

### 7.2 缓解措施详情

1. **详细代码审查**
   - 每个提取的函数需要至少2人审查
   - 检查所有边界条件
   - 验证 Redis 操作的正确性

2. **测试覆盖**
   - Phase 1 函数测试覆盖率 > 95%
   - Phase 2 函数测试覆盖率 > 90%
   - Phase 3 函数测试覆盖率 > 85%

3. **性能基准**
   - 建立优化前的性能基准
   - 每个 Phase 后运行基准测试
   - 对比结果，确保无回退

4. **灰度发布**
   - Phase 1 优先部署到测试环境
   - Phase 2/3 在 Phase 1 稳定后推进
   - 监控异常指标

---

## 8. 预期成果总结

### 8.1 代码质量指标

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| 代码重复率 | 35% | 15% | -20% |
| 平均函数大小 | 25行 | 18行 | -28% |
| 可维护性分数 | 65/100 | 82/100 | +26% |
| 测试覆盖率 | 70% | 90% | +20% |

### 8.2 维护成本

| 方面 | 优化前 | 优化后 | 节省 |
|------|--------|--------|------|
| 维护点数 | 6+ | 1 | 83% |
| 变更影响范围 | 广泛 | 受限 | 显著 |
| 回归测试时间 | 3小时 | 1小时 | 67% |
| 文档维护 | 多处 | 统一 | 显著 |

### 8.3 开发效率提升

- 新增类似功能时，代码复用率提高 40%
- Bug 修复时，受影响的文件数减少 50%
- 代码审查时间减少 30%

---

## 9. 附录：检查清单

### Phase 1 检查清单
```
新建文件：
- [ ] verify-job-token.lua
- [ ] cleanup-group-if-empty.lua
- [ ] decrement-group-job-count.lua
- [ ] remove-job-from-active-list.lua

修改文件：
- [ ] complete.lua
- [ ] complete-with-metadata.lua
- [ ] dead-letter.lua
- [ ] delete-job-completely.lua
- [ ] clean-status.lua
- [ ] complete-and-reserve-next-with-metadata.lua
- [ ] handle-job-retry-with-backoff.lua

测试：
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 性能基准测试通过
- [ ] 代码审查通过
```

### Phase 2 检查清单
```
新建文件：
- [ ] get-current-time-ms.lua
- [ ] generate-job-score.lua
- [ ] record-flow-child-result.lua

修改文件：
- [ ] enqueue.lua
- [ ] enqueue-batch.lua
- [ ] enqueue-flow.lua
- [ ] record-job-result.lua
- [ ] complete-with-metadata.lua
- [ ] complete-and-reserve-next-with-metadata.lua

测试：
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 性能基准测试通过
- [ ] 代码审查通过
```

### Phase 3 检查清单
```
新建文件：
- [ ] promote-parent-if-all-children-complete.lua
- [ ] handle-child-job-deletion.lua

修改文件：
- [ ] record-job-result.lua
- [ ] complete-with-metadata.lua
- [ ] complete-and-reserve-next-with-metadata.lua
- [ ] clean-status.lua
- [ ] delete-job-completely.lua

测试：
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 性能基准测试通过
- [ ] 代码审查通过
- [ ] 全量回归测试通过
```

---

## 10. 文档修订历史

| 版本 | 日期 | 修改 | 作者 |
|------|------|------|------|
| v1.0 | 2025-12-29 | 初始版本，完整的分阶段实施计划 | Claude |

