# PRD: GroupMQ Lua 脚本模块化重构方案 (Phase 2)

## 1. 设计哲学与核心目标

**核心理念：主脚本应是“流程图”，而非“代码堆”。**

在 Phase 1 重构中，我们将 `complete-with-metadata.lua` 从百行“面条代码”转变为清晰的 6 步流程调用。Phase 2 的目标是将这种清晰度推广到系统的其他核心部分。

- **现状**：`clean-status.lua` 和 `enqueue.lua` 中充斥着底层的 Redis 命令（`ZADD`, `HMSET`, `SREM` 等），导致业务流程被淹没在实现细节中。
- **目标**：重构后的主脚本应当只包含高级业务动词（如 `storeJob`, `addToGroup`, `removeFromParent`），让人一眼看清业务流转逻辑。

## 2. 重构范围

本次重构聚焦于 **任务创建 (Enqueue)**、**批量清理 (Clean)** 以及 **任务获取 (Reserve)** 过程中的代码重复与逻辑混杂问题。

## 3. 新增模块定义 (Implementation Details)

请在 `includes/` 下创建以下新模块，负责封装底层实现细节：

### 3.1. Flow 关系解除模块

**文件路径**: `includes/flow/remove-child-from-parent.lua`
**依赖**: `includes/group-lifecycle/update-group-ready-limited-state`
**功能**: 封装“当子任务被删除时，如何更新父任务”的复杂逻辑。
**逻辑提取源**: 参考 `clean-status.lua` 第 1551-1598 行。
**伪代码**:

```lua
-- 参数: ns, parentId, childId
-- 1. SREM parentChildrenKey childId
-- 2. HDEL flowResultsKey childId (清理残留数据)
-- 3. HINCRBY parentKey "flowRemaining" -1
-- 4. 如果 remaining <= 0:
--    处理父任务晋升逻辑 (waiting-children -> waiting)
--    并调用 updateGroupReadyLimitedState
```

### 3.2. 任务存储核心模块

**文件路径**: `includes/job-lifecycle/store-job.lua`
**功能**: 封装任务数据的构建与存储细节。
**伪代码**:

```lua
-- 参数: ns, jobId, groupId, data, opts (maxAttempts, timestamp, delay, etc.)
-- 1. 生成 seq (INCR seqKey)
-- 2. 计算 score
-- 3. HMSET jobKey ...
-- 4. 返回: score, seq
```

### 3.3. 任务入组路由模块

**文件路径**: `includes/group-state/add-job-to-group.lua`
**依赖**: `includes/group-lifecycle/update-group-ready-limited-state`
**功能**: 封装任务的“路由”逻辑（去 Delayed、Stage 还是 Group Waiting）。
**伪代码**:

```lua
-- 参数: ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs
-- 1. SADD groups, HINCRBY groupMeta count
-- 2. 判断逻辑:
--    if delayUntil > now: 加入 Delayed ZSET, HSET status=delayed
--    elseif orderingDelayMs > 0: 加入 Stage ZSET, HSET status=staged
--    else: 加入 Group ZSET, HSET status=waiting, 并调用 updateGroupReadyLimitedState
```

### 3.4. 过期检查触发器

**文件路径**: `includes/stalled-recovery/try-trigger-stalled-check.lua`
**依赖**: `includes/stalled-recovery/recover-stalled-jobs-complete`
**功能**: 封装 Stalled Check 的频率控制（Throttling）与触发逻辑。
**逻辑提取源**: `reserve.lua` 头部的各种 check 和 time 判断。

## 4. 现有脚本修改计划

### 4.1. 重构 `clean-status.lua`

- **目标效果**: 将原来的大段 `for` 循环体精简为 3-4 行核心调用。
- **引入**:
  - `includes/flow/remove-child-from-parent`
  - `includes/group-lifecycle/cleanup-if-group-empty` (Phase 1 已创建)
- **修改**:
  - **Step 1**: 删除原有的群组判断逻辑，替换为调用 `cleanupIfGroupEmpty(...)`。
  - **Step 2**: 删除原有的父子关系解除逻辑，替换为调用 `removeChildFromParent(...)`。
  - **Step 3**: 保留核心的 `ZREM setKey` 和 `DEL jobKey` 等清理操作。

### 4.2. 重构 `delete-job-completely.lua` (Include 文件本身)

- **修改**: 内部也应调用 `includes/flow/remove-child-from-parent`。
- **目的**: 确保“删除单个任务”和“批量清理任务”底层逻辑的绝对一致性。

### 4.3. 重构 `enqueue.lua` / `enqueue-batch.lua` / `enqueue-flow.lua`

- **目标效果**: 主脚本应清晰展示“校验 -> 存储 -> 入组”的流程。
- **引入**: `store-job` 和 `add-job-to-group`。
- **修改**: 将冗长的 `HMSET` 和 `ZADD` 逻辑替换为上述两个函数的调用。

### 4.4. 重构 `reserve.lua` / `reserve-batch.lua`

- **引入**: `try-trigger-stalled-check`。
- **修改**: 将头部约 40 行的过期检查代码替换为一行函数调用 `tryTriggerStalledCheck(...)`。

## 5. 执行提示

请执行 GroupMQ 的 Phase 2 重构。请时刻牢记：**我们要让主脚本变成清晰的业务流程图。**

1.  **创建模块**：首先创建第 3 节中定义的新 `includes` 模块。确保逻辑提取准确，不要遗漏副作用（如 incrby count）。
2.  **重构 Clean**：重构 `clean-status.lua`。利用新模块消除内联逻辑。
3.  **重构 Enqueue**：重构 `enqueue` 系列脚本。将数据的“存储”与“路由”分离。
4.  **重构 Reserve**：封装 Stalled Check。
5.  **展示结果**：请展示重构后的 `clean-status.lua` 和 `enqueue.lua`，并说明代码行数的变化情况。

