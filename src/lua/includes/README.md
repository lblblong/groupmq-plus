# Lua Includes - 函数索引

本目录包含所有可复用的 Lua 函数模块。

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
  - 被调用于：complete-job.lua

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

- **总函数数**：29
- **被使用的函数**：28（96.6%）
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
