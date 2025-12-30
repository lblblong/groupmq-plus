**Phase 3 的重点将转向“毛细血管”和“维护任务”**。
目前，`promote-staged.lua`（晋升）、`cleanup.lua`（超时回收）以及 `change-delay.lua`（修改延迟）中依然存在手写的群组状态管理逻辑（手动检查 Capacity、手动操作 Ready/Limited 集合）。这不仅代码重复，而且一旦群组调度逻辑变更（比如增加优先级），这些分散的地方很容易漏改。

以下是 **Phase 3 重构 PRD**，旨在统一所有的“状态迁移”与“群组健康检查”逻辑。

---

# PRD: GroupMQ Lua 脚本模块化重构方案 (Phase 3)

## 1. 背景与目的

经过前两个阶段，核心业务流已实现“流程图化”。但在**维护性脚本**（如任务晋升、超时回收、修改延迟）中，依然散落着大量手动维护 `Ready/Limited` 队列和手动检查 Group Capacity 的底层代码。
Phase 3 的目标是**彻底消除手动状态管理**，确保系统中所有涉及“任务移动”的操作都通过统一的 `includes` 模块来维护群组的一致性。

## 2. 重构范围

本次重构聚焦于 **任务晋升 (Promote)**、**超时回收 (Cleanup)** 以及 **辅助操作 (Poison Check/Change Delay)**。

涉及修改的主脚本：

- `promote-staged.lua`
- `cleanup.lua` (注意：这是处理 Visibility Timeout 的脚本，非 `clean-status`)
- `cleanup-poisoned-group.lua`
- `change-delay.lua`

## 3. 新增模块定义 (Implementation Details)

请在 `includes/` 下创建以下新模块：

### 3.1. 单任务恢复模块

**文件路径**: `includes/job-recovery/recover-single-job.lua`
**依赖**: `includes/group-lifecycle/update-group-ready-limited-state`
**功能**: 封装“将一个正在处理或超时的任务恢复到等待或延迟状态”的核心逻辑。
**适用场景**: `cleanup.lua` (超时) 和 `recover-stalled-jobs-complete.lua` (卡死)。
**伪代码**:

```lua
-- 参数: ns, jobId, groupId, jobScore, delayUntil, now
-- 1. ZREM processingKey, DEL procKey, LREM activeKey (清理处理状态)
-- 2. 判断恢复目标:
--    if delayUntil > now:
--       HSET status=delayed, ZADD delayedKey
--       (注意: 延迟任务不占用群组 active 计数，不需要立即 updateGroupState，除非它是头部)
--    else:
--       HSET status=waiting, ZADD groupKey
-- 3. 获取群组头部并调用 updateGroupReadyLimitedState
-- 4. 返回: "recovered" or "delayed"
```

### 3.2. 群组健康分析模块

**文件路径**: `includes/group-analysis/analyze-group-poisoning.lua`
**功能**: 检查群组是否“中毒”（即所有任务都已失败达到最大重试次数，无法被处理）。
**逻辑提取源**: `cleanup-poisoned-group.lua`。
**伪代码**:

```lua
-- 参数: ns, groupId
-- 1. 遍历群组 ZSET (ZRANGE)
-- 2. 检查每个任务的 attempts < maxAttempts
-- 3. 统计可处理任务数
-- 4. 返回: boolean (isPoisoned)
```

## 4. 现有脚本修改计划

### 4.1. 重构 `promote-staged.lua`

- **现状**: 包含大段的手动 Active Count 检查和 Ready/Limited 队列操作 (Line 1680+ in repomix)。
- **修改**:
  - 保留 `ZRANGEBYSCORE` 获取 Staged 任务的逻辑。
  - **核心替换**: 将任务移入 Group ZSET 后，直接调用 `includes/group-lifecycle/update-group-ready-limited-state` 来决定群组去向。
  - **消除**: 删除所有手写的 `if currentActive >= limit then ...` 逻辑。

### 4.2. 重构 `cleanup.lua`

- **现状**: 这是处理 Visibility Timeout 的脚本。它手动执行了“恢复任务”的所有步骤，与 Phase 1/2 的风格不符。
- **引入**: `includes/job-recovery/recover-single-job`。
- **修改**:
  - 遍历过期任务列表。
  - 调用 `recoverSingleJob(...)` 处理恢复细节。
  - **目标**: 主循环体应缩减至 5 行以内。

### 4.3. 重构 `cleanup-poisoned-group.lua`

- **引入**: `includes/group-analysis/analyze-group-poisoning`。
- **修改**: 将遍历检查逻辑替换为函数调用。

### 4.4. 重构 `change-delay.lua`

- **现状**: 手动处理从 Delayed -> Group 或 Group -> Delayed 的迁移，并手动维护 Ready/Limited。
- **引入**:
  - `includes/group-lifecycle/cleanup-if-group-empty` (当任务移出群组变成 Delayed 时使用)
  - `includes/group-lifecycle/update-group-ready-limited-state` (当任务移入群组变成 Waiting 时使用)
- **修改**: 替换底层的 ZADD/ZREM 后的状态维护代码。

## 5. 执行提示 (Prompt for AI)

> **给 AI 的指令：**
>
> 请执行 GroupMQ 的 Phase 3 重构。目标是统一“维护类”脚本的底层逻辑。
>
> 1.  **创建模块**：创建第 3 节中定义的 `includes/job-recovery/` and `includes/group-analysis/` 模块。
> 2.  **重构 Promote**：修改 `promote-staged.lua`，使用 `update-group-ready-limited-state` 替代手写的容量检查逻辑。
> 3.  **重构 Cleanup**：修改 `cleanup.lua`，使用 `recover-single-job` 封装超时恢复逻辑。
> 4.  **重构 Others**：简化 `cleanup-poisoned-group.lua` 和 `change-delay.lua`，复用现有的生命周期管理模块。
> 5.  **展示结果**：请展示重构后的 `cleanup.lua` 和 `promote-staged.lua`。

