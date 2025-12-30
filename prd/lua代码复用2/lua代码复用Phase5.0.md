**Phase 5：系统级优化与清理 (System-Level Optimization & Cleanup)**

虽然核心逻辑已经很干净了，但作为“完美主义者”的最后一步，我们还需要关注系统的整体健康度、边缘情况和性能微调。目前的系统中还存在一些可以进一步抽象的**“系统级操作”**，例如：

1.  **暂停/恢复 (Pause/Resume)**：目前还是在脚本开头手动检查 `GET ns:paused`。
2.  **限流与配额 (Rate Limiting / Quota)**：虽然目前代码里只有并发限制，但未来扩展限流功能时，不应侵入业务逻辑。
3.  **最终的死信处理**：`dead-letter.lua` 虽然在 Phase 1 被简单重构过，但它其实是“移除 + 归档”的组合，应该有更标准的流程。

以下是 **Phase 5 重构 PRD**，旨在处理这些“横切关注点 (Cross-Cutting Concerns)”。

---

# PRD: GroupMQ Lua 脚本模块化重构方案 (Phase 5)

## 1. 背景与目的

经过前四个阶段，业务逻辑已高度模块化。但在所有 `reserve` 和 `enqueue` 类脚本的开头，依然充斥着手写的**前置检查逻辑**（如暂停检查）。此外，系统的扩展性依赖于能否优雅地插入新的控制逻辑（如全局限流）。
Phase 5 的目标是引入**中间件模式 (Middleware Pattern)** 的思想，将所有“前置检查”和“系统级控制”封装起来，使主脚本只关注核心业务。

## 2. 重构范围

本次重构聚焦于 **前置检查 (Pre-checks)**、**全局状态管理 (Global State)** 和 **系统清理 (System Cleanup)**。

涉及修改的主脚本：

- 所有 `reserve-*.lua` (引入暂停检查模块)
- `dead-letter.lua` (进一步标准化)
- `remove.lua` (确保原子性)

## 3. 新增模块定义 (Implementation Details)

请在 `includes/` 下创建以下新模块：

### 3.1. 队列状态检查器 (Queue Guard)

**文件路径**: `includes/common/is-queue-paused.lua`
**功能**: 封装队列是否暂停的检查。未来如果增加“群组级暂停”或“分区暂停”，只需修改此文件。
**伪代码**:

```lua
-- 参数: ns
-- 返回: boolean (true if paused)
local function isQueuePaused(ns)
  return redis.call("GET", ns .. ":paused")
end
```

### 3.2. 死信归档器 (Dead Letter Archiver)

**文件路径**: `includes/job-lifecycle/move-to-dead-letter.lua`
**功能**: 封装将任务移动到死信队列的动作（虽然目前 GroupMQ 可能是直接删除，但这为未来保留死信数据留出接口）。
**伪代码**:

```lua
-- 参数: ns, jobId, groupId, data...
-- 目前逻辑可能只是清理，但封装后未来可扩展为 ZADD dead-letter
```

_(注：根据现有代码 `dead-letter.lua` 主要是清理，所以此模块重点在于统一“清理并可能的归档”这一语义)_

## 4. 现有脚本修改计划

### 4.1. 重构 `reserve.lua` / `reserve-batch.lua` / `reserve-atomic.lua`

- **引入**: `includes/common/is-queue-paused`
- **修改**: 将脚本开头的 `if redis.call("GET", ns .. ":paused") then return ... end` 替换为模块调用。
- **意义**: 代码语义更强，且统一了暂停行为的返回值（是返回 `nil` 还是 `{}` 还是特定的错误码）。

### 4.2. 深度重构 `dead-letter.lua`

- **现状**: 虽然 Phase 1 引入了 `verify-token` 和 `remove-job-from-active`，但中间依然有一大段手写的“移除+递减计数+检查群组空”的逻辑。
- **修改**:
  - 这部分逻辑其实和 `delete-job-completely.lua` 非常像。
  - **核心决策**: `dead-letter` 本质上就是“在校验 Token 后的 delete-job-completely”。
  - **重构**: 让 `dead-letter.lua` 直接调用 `delete-job-completely`（或者复用其大部分逻辑）。需要注意的是 `dead-letter` 有 Token 校验的前置条件，而 `remove` 没有。

### 4.3. 统一 `loader.ts` 中的脚本列表

- **检查**: 确保 `loader.ts` 中注册了所有新的主脚本（如果有新增的话），并清理掉任何因重构而不再使用的旧脚本（如果有）。
- _(目前看主要是修改现有脚本，无需大改 loader.ts，但需核对)_

## 5. 执行提示 (Prompt for AI)

> **给 AI 的指令：**
>
> 请执行 GroupMQ 的 Phase 5 重构。目标是封装“横切关注点”并进行最后的代码清理。
>
> 1.  **创建通用检查模块**: 创建 `includes/common/is-queue-paused.lua`。
> 2.  **应用检查**: 在所有 `reserve` 脚本中应用 `isQueuePaused`。
> 3.  **优化 Dead Letter**: 再次审视 `dead-letter.lua`。它的核心逻辑（移除任务、更新群组、清理 Key）与 `delete-job-completely.lua` 高度重复。请重构 `dead-letter.lua`，使其在校验 Token 通过后，直接调用 `includes/job-lifecycle/delete-job-completely.lua` 来执行删除操作。
>     - _注意_: `delete-job-completely` 需要处理“任务可能还在 processing 集合中”的情况，确保它能兼容 `dead-letter` 的场景。
> 4.  **展示结果**: 请展示重构后的 `reserve.lua` 和 `dead-letter.lua`。
