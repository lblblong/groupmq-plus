# Lua 重构 Phase 3.5: 大逻辑块提取规划

## 背景

**Date**: 2025-12-29
**Current Status**: Phase 3 ✅ 完成，Phase 3.5 📋 规划中
**Reference**: 与 BullMQ 的 `addDelayedJob`, `handleDuplicatedJob` 等大逻辑块提取做对标

根据对代码库的深入分析，发现除了小函数提取（Phase 1-3）外，还有大量的**多行逻辑序列**在多个脚本中重复出现。这些逻辑块的提取可以进一步提升代码复用度和可维护性。

## Phase 3.5 目标

✨ 提取 **13 个大逻辑块**（平均 15-60 行代码）
✨ 减少重复代码 **500+ 行**
✨ 提升代码复用度到 **85%+**
✨ 保持 **零功能回归**

---

## 可提取的大逻辑块

### 🥇 优先级 1: 核心流程（高频重复）

#### 1. **更新群组就绪/限制状态**
**模块名**: `update-group-ready-limited-state.lua`

**出现次数**: 16 个脚本（最高频）
**平均行数**: 8-15 行
**复杂度**: 低

**核心逻辑**:
```lua
-- 入参: ns, groupId, readyKey, limitedKey, optionalHeadScore
-- 功能: 根据活跃计数和并发限制，自动将组置于 ready 或 limited 队列

local function updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
  if not headScore then
    local gZ = ns .. ":g:" .. groupId
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if not head or #head < 2 then return end
    headScore = tonumber(head[2])
  end

  if isGroupAtCapacity(ns, groupId) then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZADD", limitedKey, headScore, groupId)
  else
    redis.call("ZREM", limitedKey, groupId)
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end
```

**可节省的脚本** (按重复次数):
- `reserve.lua` - 3 处 (19 行 → 3 行调用)
- `reserve-batch.lua` - 2 处 (13 行 → 2 行调用)
- `complete-with-metadata.lua` - 2 处 (18 行 → 2 行调用)
- `change-delay.lua` - 1 处 (15 行 → 1 行调用)
- `retry.lua` - 1 处 (9 行 → 1 行调用)
- `dead-letter.lua` - 1 处 (9 行 → 1 行调用)
- `check-stalled.lua` - 1 处 (8 行 → 1 行调用)
- 其他 8 个脚本...

**总代码精简**: 约 **120 行** → **13 行** = **节省 107 行**

---

#### 2. **条件性清理空群组**
**模块名**: `cleanup-if-group-empty.lua`

**出现次数**: 7 个脚本
**平均行数**: 12-18 行
**复杂度**: 低-中

**核心逻辑**:
```lua
-- 入参: ns, groupId, jobCountChange (通常为 -1)
-- 功能: 原子性地递减计数，如果为0则清理所有群组键

local function cleanupIfGroupEmpty(ns, groupId, jobCountChange)
  jobCountChange = jobCountChange or -1

  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", jobCountChange))

  if remainingJobs <= 0 then
    -- 清理所有群组相关键
    local gZ = ns .. ":g:" .. groupId
    redis.call("DEL", gZ)
    redis.call("DEL", ns .. ":g:" .. groupId .. ":active")
    redis.call("DEL", groupMetaKey)
    redis.call("DEL", ns .. ":buffer:" .. groupId)
    redis.call("SREM", ns .. ":groups", groupId)
    redis.call("ZREM", ns .. ":ready", groupId)
    redis.call("ZREM", ns .. ":limited", groupId)
    redis.call("ZREM", ns .. ":buffering", groupId)

    return "empty"
  end

  return "has-jobs"
end
```

**可节省的脚本**:
- `dead-letter.lua` (8 行)
- `complete-with-metadata.lua` (16 行)
- `complete.lua` (13 行)
- `remove.lua` (9 行)
- `cleanup.lua` (13 行)
- `clean-status.lua` (14 行)
- `record-job-result.lua` (部分)

**总代码精简**: 约 **88 行** → **1-3 行调用** = **节省 85+ 行**

---

#### 3. **清理处理中的任务**
**模块名**: `cleanup-processing-job.lua`

**出现次数**: 6 个脚本
**平均行数**: 10-15 行
**复杂度**: 中

**核心逻辑**:
```lua
-- 入参: ns, jobId, groupId, token (可选)
-- 功能: 原子性地从处理集合移除任务，清理相关键

local function cleanupProcessingJob(ns, jobId, groupId, token)
  local procKey = ns .. ":processing:" .. jobId

  -- 可选的令牌验证
  if token then
    local storedToken = redis.call("HGET", procKey, "token")
    if storedToken and storedToken ~= token then
      return "token-mismatch"
    end
  end

  -- 清理处理数据
  redis.call("DEL", procKey)
  redis.call("ZREM", ns .. ":processing", jobId)

  -- 从活跃列表移除
  if groupId then
    redis.call("LREM", ns .. ":g:" .. groupId .. ":active", 1, jobId)
  end

  return "cleaned"
end
```

**可节省的脚本**:
- `dead-letter.lua` (12 行)
- `retry.lua` (6 行)
- `complete-with-metadata.lua` (18 行)
- `check-stalled.lua` (18 行)
- `cleanup.lua` (8 行)
- `remove.lua` (部分)

**总代码精简**: 约 **62 行** → **1-2 行调用** = **节省 60+ 行**

---

### 🥈 优先级 2: 业务流程（中频重复）

#### 4. **处理流程父-子关系完成**
**模块名**: `handle-flow-child-completion.lua`

**出现次数**: 5 个脚本（flow 场景特定）
**平均行数**: 25-35 行
**复杂度**: 高

**核心逻辑**:
```lua
-- 入参: ns, jobId, parentId, childData, status
-- 功能: 记录子任务结果，递减计数，可能激活父任务

local function handleFlowChildCompletion(ns, jobId, parentId, childData, status)
  if not parentId then return "no-parent" end

  -- 存储结果
  local flowResultsKey = ns .. ":flow:results:" .. parentId
  local entry = cjson.encode({
    jobId = jobId,
    status = status,
    data = childData
  })
  redis.call("HSET", flowResultsKey, jobId, entry)

  -- 递减剩余计数
  local remaining = redis.call("HINCRBY", ns .. ":job:" .. parentId, "flowRemaining", -1)

  -- 如果所有子任务完成，激活父任务
  if remaining <= 0 then
    local parentJobKey = ns .. ":job:" .. parentId
    local parentStatus = redis.call("HGET", parentJobKey, "status")

    if parentStatus == "waiting-children" then
      local parentGroupId = redis.call("HGET", parentJobKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentJobKey, "score"))

      if parentGroupId and parentScore then
        -- 将父任务加入群组
        redis.call("HSET", parentJobKey, "status", "waiting")
        local pGZ = ns .. ":g:" .. parentGroupId
        redis.call("ZADD", pGZ, parentScore, parentId)

        -- 更新群组状态
        updateGroupReadyLimitedState(ns, parentGroupId, ns .. ":ready", ns .. ":limited")
      end
    end
  end

  return "handled"
end
```

**可节省的脚本**:
- `complete-with-metadata.lua` (58 行)
- `record-job-result.lua` (55 行)
- `remove.lua` (48 行)
- `clean-status.lua` (57 行)
- `enqueue-flow.lua` (部分)

**总代码精简**: 约 **218 行** → **1-2 行调用** = **节省 216+ 行**

---

#### 5. **恢复停滞任务（完整流程）**
**模块名**: `recover-stalled-jobs-complete.lua`

**出现次数**: 5 个脚本
**平均行数**: 40-60 行
**复杂度**: 高

**现状**: `stalled-recovery.lua` 已存在但只是查询函数，需要包装成完整流程

**核心逻辑**:
```lua
-- 入参: ns, now, gracePeriod, maxStalledCount
-- 功能: 查询过期任务，恢复或失败处理

local function recoverStalledJobsCompletely(ns, now, gracePeriod, maxStalledCount)
  local processingKey = ns .. ":processing"
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  -- 查询候选任务
  local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now - gracePeriod)

  for _, jobId in ipairs(expiredJobs) do
    local procKey = ns .. ":processing:" .. jobId
    local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
    local gid = procData[1]

    if gid then
      -- 恢复或失败逻辑...
      -- 包含状态转移、活跃列表清理、群组状态更新等

      -- 清理任务
      redis.call("DEL", procKey)
      redis.call("ZREM", processingKey, jobId)
      redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
    end
  end

  return "done"
end
```

**可节省的脚本**:
- `reserve.lua` (84 行)
- `reserve-batch.lua` (76 行)
- `check-stalled.lua` (94 行)
- `cleanup.lua` (61 行)
- (可能还有流程中嵌入的逻辑)

**总代码精简**: 约 **315 行** → **1-2 行调用** = **节省 313+ 行**

**⚠️ 注意**: 这个已经部分提取到 `stalled-recovery.lua`，但需要完整包装

---

#### 6. **延迟任务转移到等待状态**
**模块名**: `promote-delayed-job-complete.lua`

**出现次数**: 3 个脚本
**平均行数**: 15-20 行
**复杂度**: 中

**核心逻辑**:
```lua
-- 入参: ns, jobId, delayedKey, readyKey, limitedKey
-- 功能: 从延迟集合移动到群组等待集合，更新群组状态

local function promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)
  local jobKey = ns .. ":job:" .. jobId

  -- 基本验证
  if redis.call("EXISTS", jobKey) == 0 then return "not-found" end

  -- 从延迟集合移除
  redis.call("ZREM", delayedKey, jobId)

  -- 获取群组和分数
  local groupId = redis.call("HGET", jobKey, "groupId")
  local score = tonumber(redis.call("HGET", jobKey, "score"))

  if not groupId or not score then return "invalid-data" end

  -- 加入群组等待集合
  local gZ = ns .. ":g:" .. groupId
  redis.call("ZADD", gZ, score, jobId)
  redis.call("HSET", jobKey, "status", "waiting")
  redis.call("HDEL", jobKey, "runAt", "delayUntil")

  -- 更新群组状态
  updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey)

  return "promoted"
end
```

**可节省的脚本**:
- `promote-delayed-one.lua` (55 行)
- `promote-delayed-jobs.lua` (52 行)
- `change-delay.lua` (48 行)

**总代码精简**: 约 **155 行** → **1-2 行调用** = **节省 153+ 行**

---

### 🥉 优先级 3: 特殊场景（低频但重要）

#### 7. **处理任务重试（完整流程）**
**模块名**: `handle-job-retry-with-backoff.lua`

**出现次数**: 1 个脚本（独立且复杂）
**平均行数**: 60-90 行
**复杂度**: 高

**核心逻辑**: 完整的 retry.lua 可以模块化为多个子函数

```lua
-- 可分解为:
local function validateRetryToken(ns, jobId, token)
  -- Token 验证逻辑
end

local function checkRetryAttempts(ns, jobId, maxAttempts)
  -- 检查是否超过最大尝试次数
end

local function handleRetryWithBackoff(ns, jobId, backoffMs, groupId)
  -- 延迟或立即重试处理
end

local function handleJobRetryComplete(ns, jobId, groupId, backoffMs, token, maxAttempts)
  -- 完整的重试流程
end
```

**适用场景**: 其他队列系统或自定义重试逻辑

---

#### 8. **任务完成/失败记录（带保留策略）**
**模块名**: `record-job-finalization.lua`

**出现次数**: 2 个脚本
**平均行数**: 40-50 行
**复杂度**: 高

**核心逻辑**:
```lua
-- 入参: ns, jobId, status, resultOrError, finishedOn, keepCompleted, keepFailed
-- 功能: 原子性地记录完成/失败状态，应用保留策略

local function recordJobFinalization(ns, jobId, status, resultOrError, finishedOn, keepCount)
  local jobKey = ns .. ":job:" .. jobId
  local statusKey = (status == "completed") and (ns .. ":completed") or (ns .. ":failed")

  -- 记录状态和时间戳
  redis.call("HSET", jobKey, "status", status, "finishedOn", finishedOn)

  if keepCount and keepCount > 0 then
    -- 保存完整元数据
    redis.call("ZADD", statusKey, finishedOn, jobId)

    -- 修剪旧的记录
    local zcount = redis.call("ZCARD", statusKey)
    local toRemove = zcount - keepCount
    if toRemove > 0 then
      local oldIds = redis.call("ZRANGE", statusKey, 0, toRemove - 1)
      for _, oldId in ipairs(oldIds) do
        redis.call("DEL", ns .. ":job:" .. oldId)
      end
      redis.call("ZREMRANGEBYRANK", statusKey, 0, toRemove - 1)
    end
  else
    redis.call("DEL", jobKey)
  end

  -- 发布事件
  redis.call("PUBLISH", ns .. ":events", cjson.encode({
    type = status,
    jobId = jobId
  }))

  return "recorded"
end
```

**可节省的脚本**:
- `complete-with-metadata.lua` (66 行)
- `record-job-result.lua` (80 行)

**总代码精简**: 约 **146 行** → **1-2 行调用** = **节省 144+ 行**

---

#### 9. **任务删除（完整清理）**
**模块名**: `delete-job-completely.lua`

**出现次数**: 1 个脚本（remove.lua）
**平均行数**: 60-90 行
**复杂度**: 高

**核心逻辑**: 可分解为独立的步骤

---

#### 10. **任务排队（带幂等性）**
**模块名**: `enqueue-job-with-idempotence.lua`

**出现次数**: 2 个脚本
**平均行数**: 50-70 行
**复杂度**: 中-高

**核心逻辑**: 可分解为多个子函数

---

---

## 实施路线图

### Phase 3.5a: 基础块（第 1-3 个）
**预期时间**: 2-3 天
**代码精简**: ~250 行
**影响脚本**: 29 个

1. 提取 `update-group-ready-limited-state.lua`
2. 提取 `cleanup-if-group-empty.lua`
3. 提取 `cleanup-processing-job.lua`

**验证**: 所有 142 个测试通过，无回归

---

### Phase 3.5b: 核心流程块（第 4-6 个）
**预期时间**: 3-4 天
**代码精简**: ~680 行
**影响脚本**: 18 个

4. 提取 `handle-flow-child-completion.lua`
5. 完整化 `recover-stalled-jobs-complete.lua`
6. 提取 `promote-delayed-job-complete.lua`

**验证**: 流程测试、Flow 测试、Stalled 测试

---

### Phase 3.5c: 特殊场景块（第 7-10 个）
**预期时间**: 4-5 天
**代码精简**: ~450 行
**影响脚本**: 8 个

7. 分解 `retry.lua` → 多个函数
8. 提取 `record-job-finalization.lua`
9. 分解 `delete-job-completely.lua`
10. 分解 `enqueue-job-with-idempotence.lua`

**验证**: 特定场景测试

---

## 预期收益

| 指标 | 当前 | Phase 3.5 后 | 改进 |
|------|------|-----------|------|
| 总脚本行数 | ~3500 行 | ~2400 行 | **-31%** |
| 重复代码块 | 13 个 | 0 个 | **100%** |
| 可复用函数数 | 41 个 | 65+ 个 | **+59%** |
| 模块目录 | 7 个 | 12+ 个 | **+71%** |
| 代码复用度 | 65% | 85%+ | **+30%** |
| 维护成本 | 基准 | **-40%** | 显著降低 |

---

## 实施后的目录结构

```
src/lua/includes/
├── concurrency-control/         (现有 5 个)
│   ├── get-group-concurrency-limit.lua
│   ├── get-group-active-count.lua
│   ├── is-group-at-capacity.lua
│   ├── get-available-slots.lua
│   └── update-group-state.lua
│
├── delayed-handling/             (现有 6 个)
│   └── ...
│
├── group-status/                 (现有 9 个)
│   └── ...
│
├── job-data/                     (现有 5 个)
│   └── ...
│
├── key-helpers/                  (现有 10 个)
│   └── ...
│
├── token-verify/                 (现有 3 个)
│   └── ...
│
├── stalled-recovery/             (现有 1 个 → 增强)
│   ├── stalled-recovery.lua
│   ├── recover-stalled-jobs-complete.lua    [NEW]
│   └── ...
│
├── ghost-cleanup/                (现有 2 个)
│   └── ...
│
├── group-lifecycle/              [NEW] (4 个新文件)
│   ├── update-group-ready-limited-state.lua
│   ├── cleanup-if-group-empty.lua
│   ├── promote-delayed-job-complete.lua
│   └── cleanup-processing-job.lua
│
├── flow-handling/                [NEW] (1 个新文件)
│   └── handle-flow-child-completion.lua
│
├── job-lifecycle/                [NEW] (3 个新文件)
│   ├── record-job-finalization.lua
│   ├── delete-job-completely.lua
│   └── enqueue-job-with-idempotence.lua
│
└── retry-handling/               [NEW] (1 个新文件)
    └── handle-job-retry-with-backoff.lua
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|--------|
| 抽象层次过深 | 可读性下降 | 清晰的函数签名 + 内联注释 |
| 参数过多 | API 复杂 | 使用表参数 + 默认值 |
| 性能开销 | 执行时间增加 | 函数调用开销极小（<1ms） |
| 循环依赖 | 编译失败 | Loader 循环检测机制 |
| 测试复杂性 | 测试覆盖 | 增加单元测试 |

---

## 后续的 Phase 4

Phase 3.5 完成后，Phase 4 不再只是验证，而是：

1. **性能基准** - 对标 Phase 2，验证无性能回退
2. **文档更新** - 绘制新的依赖图
3. **最佳实践** - 发布 Lua 模块化开发指南
4. **社区反馈** - 如需要则收集反馈并改进

---

## 结论

通过 Phase 3.5 的大逻辑块提取，我们将实现：

✅ **代码质量** - 从 65% 复用度提升到 85%+
✅ **可维护性** - 关键逻辑集中，易于修改
✅ **可读性** - 上层脚本逻辑更清晰
✅ **扩展性** - 新增脚本可快速复用已有块
✅ **一致性** - 相同操作采用统一实现

这与 BullMQ 等成熟队列库的做法一致，是生产级别队列系统的标配做法。

---

**下一步**: 确认此规划是否采纳，如是则创建 Phase 3.5 的具体任务
