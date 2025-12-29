# Lua Includes - GroupMQ+ 核心方法库

本目录包含 GroupMQ+ Redis Lua 脚本所需的所有辅助函数和工具库。这些模块组织了系统的核心功能模块。

## 目录结构

```
includes/
├── concurrency-control/      # 并发控制
├── delayed-handling/         # 延迟处理
├── ghost-cleanup/            # 幽灵任务清理
├── group-lifecycle/          # 组生命周期
├── group-status/             # 组状态查询
├── job-data/                 # 任务数据处理
├── job-lifecycle/            # 任务生命周期
├── key-helpers/              # Redis 键构建
├── retry-handling/           # 重试处理
└── stalled-recovery/         # 卡滞恢复
```

## 模块详情

### 1. 并发控制 (concurrency-control/)

处理组并发限制和容量管理。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `getGroupConcurrencyLimit` | get-group-concurrency-limit.lua | 获取组并发限制数 (默认为 1) |
| `getGroupActiveCount` | get-group-active-count.lua | 获取当前活跃任务数 |
| `isGroupAtCapacity` | is-group-at-capacity.lua | 检查组是否已达容量 |

### 2. 延迟处理 (delayed-handling/)

处理任务延迟和定时晋升。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `promoteJobFromDelayed` | promote-job-from-delayed.lua | 从延迟集合晋升任务到等待集合 |
| `promoteDelayedJobToWaiting` | promote-delayed-job-complete.lua | 完整的延迟任务晋升流程，包括状态更新和组状态调整 |

### 3. 幽灵任务清理 (ghost-cleanup/)

检测和处理无效或孤立的任务。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `detectGhostTasks` | detect-ghost-tasks.lua | 检测组中缺失处理记录的幽灵任务 (仅检测，不清理) |

### 4. 组生命周期 (group-lifecycle/)

管理组的创建、状态转换和清理。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `updateGroupReadyLimitedState` | update-group-ready-limited-state.lua | 根据活跃计数和容量，自动将组置于 ready 或 limited 队列 |

### 5. 组状态查询 (group-status/)

查询组的实时状态信息。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `getGroupJobCount` | get-group-job-count.lua | 获取组中待处理任务总数 |
| `getGroupHeadJob` | get-group-head-job.lua | 获取组中的头部任务 (下一个待处理) |
| `getGroupActiveTaskCount` | get-group-active-task-count.lua | 获取组中当前正在处理的任务数 |

### 6. 任务数据处理 (job-data/)

处理任务数据的序列化和解析。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `getJobFullData` | get-job-full-data.lua | 读取任务的 10 个核心字段 (id, groupId, data, attempts, maxAttempts, seq, timestamp, orderMs, score, isFlowParent) |
| `parseJobData` | parse-job-data.lua | 将数组格式的任务数据转换为具名对象 |

### 7. 任务生命周期 (job-lifecycle/)

管理单个任务的完整生命周期。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `deleteJobCompletely` | delete-job-completely.lua | 完整删除任务及其所有关联数据 (包括 flow 关系、组状态更新等) |
| `recordJobFinalization` | record-job-finalization.lua | 原子性记录任务完成/失败状态，应用保留策略并发布事件 |

### 8. Redis 键构建工具 (key-helpers/)

统一构建各类 Redis 键名，确保命名一致。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `makeGroupKey` | make-group-key.lua | 构造组的任务集合键 (e.g., "ns:g:groupId") |
| `makeActiveListKey` | make-active-list-key.lua | 构造组的活跃列表键 (e.g., "ns:g:groupId:active") |
| `makeConfigKey` | make-config-key.lua | 构造组配置键 (e.g., "ns:config:groupId") |
| `makeGroupMetaKey` | make-group-meta-key.lua | 构造组元数据键 (e.g., "ns:g:groupId:meta") |
| `makeGroupLockKey` | make-group-lock-key.lua | 构造组锁键 (e.g., "ns:lock:groupId") |
| `makeJobKey` | make-job-key.lua | 构造任务数据哈希键 (e.g., "ns:job:jobId") |
| `makeProcessingKey` | make-processing-key.lua | 构造任务处理锁键 (e.g., "ns:processing:jobId") |
| `makeUniqueKey` | make-unique-key.lua | 构造任务幂等性键 (e.g., "ns:unique:jobId") |

### 9. 重试处理 (retry-handling/)

处理任务重试和回退策略。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `handleJobRetryWithBackoff` | handle-job-retry-with-backoff.lua | 处理任务重试，支持令牌验证、尝试次数检查、延迟或立即重试 |

### 10. 卡滞恢复 (stalled-recovery/)

检测和恢复卡滞的任务。

| 函数名 | 文件 | 说明 |
|--------|------|------|
| `recoverStalledJobsCompletely` | recover-stalled-jobs-complete.lua | 查询过期任务，判断是否应失败或恢复，支持延迟任务的状态保持 |

## 使用指南

### 导入方式

在主 Lua 脚本中使用 `@include` 指令导入所需函数：

```lua
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- 现在可以使用 getGroupConcurrencyLimit 和 updateGroupReadyLimitedState
```

### 依赖关系

某些函数依赖其他函数。导入时需要确保依赖的函数也被导入。例如：

- `isGroupAtCapacity` 依赖 `getGroupConcurrencyLimit` 和 `getGroupActiveCount`
- `updateGroupReadyLimitedState` 依赖 `isGroupAtCapacity`
- `handleJobRetryWithBackoff` 依赖 `isGroupAtCapacity` 和 `updateGroupReadyLimitedState`

### 参数约定

所有函数遵循以下参数约定：

- **ns**: Redis 命名空间前缀 (e.g., "myqueue")
- **groupId**: 任务组标识符
- **jobId**: 任务唯一标识符
- **Redis Keys**: 预构造的 Redis 键名 (可选，若不提供会自动生成)

### 返回值

函数返回值类型多样：

- **数字**: 计数或状态码 (e.g., `-1` 失败, `-2` 令牌错误, `0` 未找到)
- **字符串**: 状态描述 (e.g., "promoted", "deleted", "recorded")
- **数组/表**: 结构化数据或多条记录
- **nil**: 未找到或不适用

## 核心工作流

### 1. 任务入队
1. 使用 `makeGroupKey` 构造组键
2. 使用 `makeJobKey` 构造任务键
3. 检查 `isGroupAtCapacity` 决定是否加入 ready 或 limited 队列
4. 使用 `updateGroupReadyLimitedState` 更新组状态

### 2. 任务执行
1. 获取组的头部任务: `getGroupHeadJob`
2. 获取任务完整数据: `getJobFullData` + `parseJobData`
3. 移到活跃列表
4. 执行任务处理

### 3. 任务完成
1. 使用 `recordJobFinalization` 记录完成状态
2. 使用 `deleteJobCompletely` 清理任务数据
3. 使用 `updateGroupReadyLimitedState` 更新组状态

### 4. 失败重试
1. 调用 `handleJobRetryWithBackoff` 处理重试
2. 若支持延迟，任务进入延迟集合
3. 定期使用 `promoteDelayedJobToWaiting` 晋升就绪任务

### 5. 卡滞恢复
1. 定期调用 `recoverStalledJobsCompletely`
2. 系统自动判断任务是否应失败或恢复

## 总函数数：24 个

### 按调用频率分类

| 级别 | 函数名 | 调用次数 |
|-----|--------|---------|
| 核心 | `updateGroupReadyLimitedState` | 17 |
| 常用 | `getGroupActiveCount`, `detectGhostTasks`, `isGroupAtCapacity`, `getGroupConcurrencyLimit`, `getJobFullData`, `promoteDelayedJobToWaiting` | 2-3 |
| 标准 | `recordJobFinalization`, `handleJobRetryWithBackoff`, `deleteJobCompletely`, `promoteJobFromDelayed`, `recoverStalledJobsCompletely` | 1-2 |
| 工具 | Redis 键构建函数、数据解析函数、查询函数 | 按需调用 |

## 性能考虑

1. **原子性**: 所有关键操作都在 Lua 脚本中原子执行，避免竞态条件
2. **批量操作**: 使用 Redis 多参数命令减少往返
3. **缓存**: 传递已计算的参数 (如 headScore) 避免重复计算
4. **索引**: Redis 有序集合实现高效的先进先出和优先级队列

## 维护说明

- 此目录中的所有方法已被深度集成，修改需谨慎
- 新增功能应遵循现有命名和参数约定
- 所有函数应包含文档注释，说明参数和返回值
- 复杂函数应使用 `@include` 指令明确声明依赖
