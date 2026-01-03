# Lua 脚本库重构实施方案

本方案旨在优化现有的 Redis Lua 脚本库，重点在于代码复用（DRY）、逻辑一致性和安全性增强。请按照以下步骤顺序执行。

## 阶段一：基础架构与公共模块提取

本阶段的目标是将重复出现的逻辑提取为独立的 `includes` 模块，为后续的核心逻辑简化打下基础。

### 任务 1: 提取"群组满转 Limited"逻辑
**问题现状**：`reserve.lua`, `reserve-batch.lua`, `reserve-atomic.lua` 中包含完全相同的“检查群组是否已满，若满则移入 Limited 集合”的代码块。
**实施目标**：创建新的公共模块封装此逻辑。
**涉及文件**：
- 新建: `includes/concurrency-control/handle-full-group.lua`
- 修改: `reserve.lua`, `reserve-batch.lua`, `reserve-atomic.lua`
**执行指令**：
1. 创建 `handle-full-group.lua`。
   - 输入参数：`ns`, `groupId`, `readyKey`, `limitedKey`。
   - 逻辑：获取 active 数量和 limit 配置；如果 `active >= limit` 且群组非空，调用 `updateGroupReadyLimitedState` 将其移入 limited 集合。
2. 在三个 `reserve` 相关脚本中引入并替换原有重复代码。

### 任务 2: 提取任务存储核心逻辑
**问题现状**：`enqueue-flow.lua` 重复了 `store-job.lua` 中生成序列号 (`seq`) 和设置 Hash 字段 (`HMSET`) 的逻辑。
**实施目标**：将原子逻辑拆分。
**涉及文件**：
- 新建: `includes/job-lifecycle/generate-job-seq.lua` (生成 score 和 seq)
- 修改: `includes/job-lifecycle/store-job.lua`
- 修改: `enqueue-flow.lua`
**执行指令**：
1. 创建 `generate-job-seq.lua`，封装基于 `orderMs` 计算 epoch、生成 `seq` 和 `score` 的逻辑。
2. 修改 `store-job.lua` 使用上述模块。
3. 修改 `enqueue-flow.lua`，使其复用 `store-job.lua` 或者使用新拆分的模块来创建父任务，确保 schema 一致性（如增加字段时只需改一处）。建议让 `store-job` 支持传入额外字段（如 `status` 覆盖），或将 `store-job` 拆分为 `prepare` 和 `save` 两个阶段。

---

## 阶段二：核心逻辑重构与合并

本阶段主要处理较为复杂的并发控制和出队逻辑的统一。

### 任务 3: 增强 Token 验证复用
**问题现状**：`heartbeat.lua` 和 `handle-job-retry...lua` 手动编写了 Token 对比逻辑，未完全复用 `verify-token.lua`。
**实施目标**：统一使用 `verify-token` 模块。
**涉及文件**：
- 修改: `includes/security/verify-token.lua`
- 修改: `heartbeat.lua`
- 修改: `includes/retry-handling/handle-job-retry-with-backoff.lua`
**执行指令**：
1. 增强 `verify-token.lua`，使其返回更详细的状态（例如返回 `1` 表示成功，`0` 表示不匹配，`-1` 表示 Key 不存在/Stalled），或者保持布尔值但覆盖所有场景。
2. 在 `heartbeat.lua` 中引入并使用。
3. 在 `handle-job-retry-with-backoff.lua` 中引入并使用，替代原有的 `HGET` 对比代码。

### 任务 4: 合并 `reserve-atomic` 与 `try-pop`
**问题现状**：`reserve-atomic.lua` 与 `try-pop-next-job.lua` 逻辑高度重合，维护成本高。
**实施目标**：让 `try-pop-next-job` 支持“豁免权”逻辑，从而废弃 `reserve-atomic` 中的独立实现。
**涉及文件**：
- 修改: `includes/concurrency-control/try-pop-next-job.lua`
- 修改: `reserve-atomic.lua`
**执行指令**：
1. 修改 `try-pop-next-job.lua`，增加可选参数 `opts.allowedJobId`。
2. 在 `try-pop` 内部检查容量 (`isGroupAtCapacity`) 之前，如果提供了 `allowedJobId`，则检查该 ID 是否存在于 Active 列表中。如果存在，跳过容量检查（视为 Chaining 豁免）。
3. 重写 `reserve-atomic.lua`，使其直接调用 `try-pop-next-job`，仅保留其特有的参数解析逻辑。

---

## 阶段三：清理与优化

本阶段处理遗留代码、死代码以及性能微调。

### 任务 5: 优化幽灵任务清理策略
**问题现状**：`try-pop-next-job` 中仅在 `activeCount >= limit` 时触发清理。如果 limit 很大，可能积累大量幽灵任务。
**实施目标**：引入概率性检查或阈值优化。
**涉及文件**：
- `includes/concurrency-control/try-pop-next-job.lua`
**执行指令**：
1. 修改触发逻辑。建议逻辑：
   - 如果 `activeCount >= limit` (原有逻辑，必查)。
   - 或者：如果 `activeCount > 0` 且 `math.random() < 0.01` (1% 概率随机检查，防止长尾积累)。

### 任务 6: 移除遗留的锁机制代码
**问题现状**：`cleanup-poisoned-group.lua` 中检查了 `ns:lock:groupId`，这是旧版 BullMQ 的分布式锁模式，现已改为 Active 列表模式。
**实施目标**：移除死代码。
**涉及文件**：
- `cleanup-poisoned-group.lua`
- `includes/job-recovery/recover-single-job.lua` (检查是否有删除 lock 的代码)
- `check-stalled.lua` (检查是否有删除 lock 的代码)
**执行指令**：
1. 在 `cleanup-poisoned-group.lua` 中删除对 `lockKey` 的获取和检查。
2. 搜索全库，确认 `ns .. ":lock:"` 相关的 `DEL` 操作是否还有保留必要（如果是为了兼容旧版本产生的数据，可以保留 DEL，但不要依赖它做逻辑判断）。

---

## 执行建议

1.  **分步提交**：每完成一个任务（Task），请运行相关的测试用例，确保没有破坏现有功能。
2.  **Repomix**：每次修改 `includes/` 下的文件后，请注意你的构建工具（Loader）是否能正确解析嵌套依赖。
3.  **主要风险点**：
    - **任务 2 (Store Job)**：确保 `enqueue-flow` 创建的父任务结构与普通任务完全一致。
    - **任务 4 (Reserve Atomic)**：确保 `allowedJobId` 的逻辑正确处理了“任务已不在 Active 列表中”的边缘情况。