# Lua Includes - 函数索引

本目录包含所有可复用的 Lua 函数模块。

## 如何编写一个函数

### 基本结构

每个函数文件应遵循以下模板结构：

```lua
--[[
  函数的简短描述和说明
  
  Parameters:
    opts.paramName: 参数说明
    opts.anotherParam: 参数说明
    
  Returns: 返回值说明
]]
--- @include "includes/category/dependency-function"
--- @include "includes/another-category/another-dependency"

local function functionName(opts)
  local ns = opts.ns
  local param1 = opts.paramName
  
  -- 函数实现逻辑
  local result = redis.call("COMMAND", ns .. ":key", param1)
  
  return result
end
```

### 编写规范

#### 1. **文件命名**
- 使用小写 kebab-case 格式：`my-function.lua`
- 文件名应清晰反映函数功能

#### 2. **注释要求**
- 在函数顶部使用 Lua 块注释 `--[[ ]]` 说明函数功能
- 列出所有参数及其说明，格式：`opts.paramName: 说明`
- 说明返回值的含义和类型
- 使用 `--- @include` 标注该函数依赖的其他 include 函数

#### 3. **参数约定**
- 所有参数通过单个 `opts` 表传入
- 必须包含 `opts.ns`（Redis 命名空间前缀）
- 参数名使用有意义的驼峰或下划线命名

#### 4. **Redis 操作**
- 使用 `redis.call()` 执行 Redis 命令
- 所有 key 应使用 `ns .. ":keyname"` 格式拼接命名空间
- 合理使用 Redis 数据结构（String, List, Set, ZSet, Hash 等）

#### 5. **返回值**
- 返回有意义的值（数字、字符串、table 或布尔值）
- 避免返回 nil，如无特定返回值则返回成功标志（如 1 或 0）

### 实际例子

#### 例子 1：简单的数据检查函数
```lua
--[[
  检查队列是否为空
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.ignoreDelayed: "1" 忽略延迟任务, "0" 检查延迟任务
    
  Returns: 1 if 队列为空, 0 if 队列非空
]]

local function checkQueueEmpty(opts)
  local ns = opts.ns
  local ignoreDelayed = opts.ignoreDelayed
  
  local processingCount = redis.call("ZCARD", ns .. ":processing")
  if processingCount > 0 then
    return 0
  end
  
  if ignoreDelayed ~= "1" then
    local delayedCount = redis.call("ZCARD", ns .. ":delayed")
    if delayedCount > 0 then
      return 0
    end
  end
  
  return 1
end
```

#### 例子 2：依赖其他函数的组合函数
```lua
--[[
  检查群组是否达到并发容量限制
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.groupId: 群组 ID
    
  Returns: true if 群组已满, false 否则
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  
  local limit = getGroupConcurrencyLimit({ ns = ns, groupId = groupId })
  local activeCount = getGroupActiveCount({ ns = ns, groupId = groupId })
  
  return activeCount >= limit
end
```

### 文件组织

- 将相关功能的函数放在同一目录下
- 按功能分类：`common/`, `concurrency-control/`, `job-lifecycle/` 等
- 每个目录可以有 include 的函数
- 提供清晰的命名，使用者可快速找到所需函数

### 调试提示

- 使用 `redis.log()` 输出调试信息到 Redis 日志
- 在复杂逻辑前添加注释，说明各步骤的目的
- 确保所有参数都有默认处理或明确的错误处理

## 文件结构概览

- **common/** - 通用工具函数
- **concurrency-control/** - 并发控制相关函数
- **dal/** - 数据访问层函数
- **delayed-handling/** - 延迟任务处理函数
- **flow/** - 流程管理函数
- **ghost-cleanup/** - 幽灵任务清理函数
- **group-analysis/** - 群组分析函数
- **group-lifecycle/** - 群组生命周期管理函数
- **group-state/** - 群组状态管理函数
- **group-status/** - 群组状态查询函数
- **job-lifecycle/** - 任务生命周期管理函数
- **job-recovery/** - 任务恢复函数
- **retry-handling/** - 重试处理函数
- **security/** - 安全验证函数
- **stalled-recovery/** - 卡住任务恢复函数

## 函数索引

### 通用工具函数 (common/)

- **checkQueueEmpty** (`common/check-queue-empty.lua`)
  - 检查队列是否为空
  - 被调用于：is-empty.lua

- **isQueuePaused** (`common/is-queue-paused.lua`)
  - 检查队列是否暂停
  - 被调用于：reserve.lua, reserve-atomic.lua, reserve-batch.lua

- **validateJobIntegrity** (`common/validate-job-integrity.lua`)
  - 验证任务 Hash 是否存在，若不存在自动清理引用
  - 被调用于：promote-delayed.lua, promote-staged.lua, recover-stalled.lua

- **validateGroupIntegrity** (`common/validate-group-integrity.lua`)
  - 验证群组是否有效，若无效自动从 Ready/Limited 队列移除
  - 被调用于：update-group-ready-limited-state.lua

### 并发控制 (concurrency-control/)

- **getGroupActiveCount** (`concurrency-control/get-group-active-count.lua`)
  - 获取群组的活跃任务数量
  - 被调用于：is-group-at-capacity.lua

- **getGroupConcurrencyLimit** (`concurrency-control/get-group-concurrency-limit.lua`)
  - 获取群组的并发限制
  - 被调用于：is-group-at-capacity.lua

- **isGroupAtCapacity** (`concurrency-control/is-group-at-capacity.lua`)
  - 检查群组是否达到并发容量限制
  - 被调用于：try-pop-next-job.lua, enqueue-batch.lua, retry.lua

- **tryPopNextJob** (`concurrency-control/try-pop-next-job.lua`)
  - 原子化地从群组中取出下一个任务
  - 被调用于：reserve.lua, reserve-batch.lua

### 数据访问层 (dal/)

- **iterateGroups** (`dal/iterate-groups.lua`)
  - 迭代所有群组
  - 被调用于：get-jobs.lua, get-queue-metrics.lua

- **readSet** (`dal/read-set.lua`)
  - 读取 Redis Set 数据结构
  - 被调用于：get-unique-groups.lua, get-unique-groups-count.lua

- **readZset** (`dal/read-zset.lua`)
  - 读取 Redis Sorted Set 数据结构
  - 被调用于：get-jobs.lua, get-queue-metrics.lua

### 延迟任务处理 (delayed-handling/)

- **promoteDelayedJobToWaiting** (`delayed-handling/promote-delayed-job-complete.lua`)
  - 将延迟任务晋升到等待状态
  - 被调用于：promote-delayed.lua, change-delay.lua

### 流程管理 (flow/)

- **removeChildFromParent** (`flow/remove-child-from-parent.lua`)
  - 从父任务中移除子任务
  - 被调用于：delete-job-completely.lua, clean-status.lua

- **updateParentFlow** (`flow/update-parent-flow.lua`)
  - 更新父任务的流程状态
  - 被调用于：complete-job.lua, complete-and-reserve-next-with-metadata.lua

### 幽灵任务清理 (ghost-cleanup/)

- **detectGhostTasks** (`ghost-cleanup/detect-ghost-tasks.lua`)
  - 检测并标记幽灵任务
  - 被调用于：try-pop-next-job.lua, reserve-atomic.lua

### 群组分析 (group-analysis/)

- **analyzeGroupPoisoning** (`group-analysis/analyze-group-poisoning.lua`)
  - 分析群组是否被"毒害"（毒害群组：所有任务都失败的群组）
  - 被调用于：cleanup-poisoned-group.lua

### 群组生命周期管理 (group-lifecycle/)

- **cleanupIfGroupEmpty** (`group-lifecycle/cleanup-if-group-empty.lua`)
  - 如果群组为空，则清理群组
  - 被调用于：delete-job-completely.lua, complete-job.lua, change-delay.lua, clean-status.lua

- **updateGroupReadyLimitedState** (`group-lifecycle/update-group-ready-limited-state.lua`)
  - 更新群组的就绪/限制状态（核心函数，被广泛使用）
  - 被调用于：reserve.lua, reserve-atomic.lua, reserve-batch.lua, promote-delayed.lua, complete-job.lua, complete-and-reserve-next-with-metadata.lua, promote-staged.lua, enqueue-batch.lua, try-trigger-stalled-check.lua, recover-stalled-jobs-complete.lua, retry.lua

### 群组状态管理 (group-state/)

- **addJobToGroup** (`group-state/add-job-to-group.lua`)
  - 将任务添加到群组
  - 被调用于：enqueue.lua, enqueue-batch.lua, enqueue-flow.lua

- **removeJobFromActive** (`group-state/remove-job-from-active.lua`)
  - 从活跃集合中移除任务
  - 被调用于：complete-job.lua, complete-and-reserve-next-with-metadata.lua

### 群组状态查询 (group-status/)

- **getGroupHeadJob** (`group-status/get-group-head-job.lua`)
  - 获取群组的头部任务
  - 被调用于：complete-job.lua

### 任务生命周期管理 (job-lifecycle/)

- **storeJob** (`job-lifecycle/store-job.lua`)
  - 存储任务数据到 Redis
  - 被调用于：enqueue.lua, enqueue-batch.lua, enqueue-flow.lua

- **moveToDeadLetter** (`job-lifecycle/move-to-dead-letter.lua`)
  - 将任务移到死信队列
  - 被调用于：dead-letter.lua

- **recordJobFinalization** (`job-lifecycle/record-job-finalization.lua`)
  - 记录任务最终化信息
  - 被调用于：complete-job.lua, complete-and-reserve-next-with-metadata.lua

- **deleteJobRetentionStorage** (`job-lifecycle/delete-job-retention-storage.lua`)
  - 删除任务 job hash、unique key 及 flow 跟踪 key
  - 被调用于：record-job-finalization.lua, clean-status.lua

- **deleteJobCompletely** (`job-lifecycle/delete-job-completely.lua`)
  - 完全删除任务
  - 被调用于：remove.lua

### 任务恢复 (job-recovery/)

- **recoverSingleJob** (`job-recovery/recover-single-job.lua`)
  - 恢复单个任务
  - 被调用于：cleanup.lua

### 重试处理 (retry-handling/)

- **handleJobRetryWithBackoff** (`retry-handling/handle-job-retry-with-backoff.lua`)
  - 使用退避算法处理任务重试
  - 被调用于：retry.lua

### 安全验证 (security/)

- **verifyToken** (`security/verify-token.lua`)
  - 验证请求令牌
  - 被调用于：complete-job.lua, complete-and-reserve-next-with-metadata.lua

### 卡住任务恢复 (stalled-recovery/)

- **recoverStalledJobsCompletely** (`stalled-recovery/recover-stalled-jobs-complete.lua`)
  - 完全恢复所有卡住的任务
  - 被调用于：check-stalled.lua

- **tryTriggerStalledCheck** (`stalled-recovery/try-trigger-stalled-check.lua`)
  - 尝试触发卡住任务检查
  - 被调用于：reserve.lua, reserve-batch.lua

## 统计信息

- **总函数数**：31
- **被使用的函数**：30（96.8%）
- **未被使用的函数**：1
  - `promoteJobFromDelayed` (delayed-handling/promote-job-from-delayed.lua) - 已被 `promoteDelayedJobToWaiting` 替代

## 关键函数

### 最常被调用的函数

- **updateGroupReadyLimitedState** - 11+ 处调用
  - 核心函数，用于管理群组的就绪状态和并发限制

- **isGroupAtCapacity** - 3+ 处调用
  - 并发控制的关键检查

- **tryPopNextJob** - 2+ 处调用
  - 原子化任务出队操作

- **removeChildFromParent** - 2+ 处调用
  - 流程任务的清理

### 功能分类的关键函数

- **入队操作**：storeJob, addJobToGroup
- **出队操作**：tryPopNextJob, updateGroupReadyLimitedState
- **任务完成**：recordJobFinalization, removeJobFromActive, cleanupIfGroupEmpty
- **流程管理**：removeChildFromParent, updateParentFlow
- **并发控制**：isGroupAtCapacity, getGroupActiveCount, getGroupConcurrencyLimit
- **故障恢复**：detectGhostTasks, recoverSingleJob, recoverStalledJobsCompletely
