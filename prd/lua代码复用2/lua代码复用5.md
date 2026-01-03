# 实施计划：Redis Lua 脚本重构与优化

## 任务 1：创建统一的群组状态刷新模块 (DRY Refactor)

**目标**：消除 `complete-job`, `remove`, `change-delay` 等脚本中重复的“检查群组是否为空，为空则清理，不为空则更新 Ready/Limited 状态”的样板代码。

**指令 Prompt：**
```text
请创建一个新的 Lua 模块文件 `includes/group-lifecycle/refresh-group-state.lua`。

1. **新建文件** `includes/group-lifecycle/refresh-group-state.lua`：
   - 引入依赖：`includes/group-lifecycle/cleanup-if-group-empty` 和 `includes/group-lifecycle/update-group-ready-limited-state`。
   - 功能逻辑：
     - 接收参数 `opts` (含 `ns`, `groupId`, `readyKey`, `limitedKey`)。
     - 首先调用 `cleanupIfGroupEmpty`。
     - 如果返回值为 `"not-empty"`（说明群组还有任务），则直接调用 `updateGroupReadyLimitedState`（该函数内部会自动获取 headScore，不需要在这里手动获取）。
     - 返回 cleanup 的结果。

2. **重构现有脚本**，使用上述新模块替换原本冗长的 if-else 逻辑：
   - 修改 `complete-job.lua`: 替换底部的 `getGroupHeadJob` ... `updateGroupReadyLimitedState` else `cleanupIfGroupEmpty` 逻辑块。
   - 修改 `change-delay.lua`: 替换底部的 `cleanupIfGroupEmpty` 调用（如果那里逻辑适用）。
   - 修改 `remove.lua` (即 `includes/job-lifecycle/delete-job-completely.lua`): 替换底部的手动清理和更新逻辑。
   - 修改 `includes/job-lifecycle/move-to-dead-letter.lua`: 替换底部的清理逻辑。

确保保持原有逻辑的原子性和正确性。
```

---

## 任务 2：提取任务物理状态查询模块 (Simplification)

**目标**：简化幂等性检查和状态变更时的逻辑，避免到处手动 `ZSCORE` 检查。

**指令 Prompt：**
```text
请创建一个新的 Lua 模块 `includes/dal/get-job-state.lua` 并重构相关代码。

1. **新建文件** `includes/dal/get-job-state.lua`：
   - 参数：`ns`, `jobId`, `groupId` (可选)。
   - 逻辑：
     - 检查 `ns:processing` (ZSCORE) -> 返回 'active'
     - 检查 `ns:delayed` (ZSCORE) -> 返回 'delayed'
     - 如果提供了 `groupId`，检查 `ns:g:{groupId}` (ZSCORE) -> 返回 'waiting'
     - 检查 `ns:completed` (ZSCORE) 或 Hash 中的 status 为 completed -> 返回 'completed'
     - 检查 `ns:failed` (ZSCORE) 或 Hash 中的 status 为 failed -> 返回 'failed'
     - 否则返回 'unknown'

2. **重构 `includes/job-lifecycle/check-idempotency.lua`**：
   - 引入并使用 `get-job-state` 模块。
   - 用清晰的 switch/case 或 if-else 结构替换原有复杂的布尔逻辑判断。

3. **(可选) 重构 `change-delay.lua`**：
   - 使用新模块来验证任务当前是否处于允许修改延迟的状态（通常只允许 'waiting' 或 'delayed'）。
```

---

## 任务 3：修复 `get-jobs.lua` 的性能隐患 (Critical Fix)

**目标**：防止 `get-jobs.lua` 在查询 `waiting` 状态时，因遍历所有群组的所有任务而导致 Redis 阻塞 (O(N*M) 复杂度)。

**指令 Prompt：**
```text
请修复 `includes/dal/iterate-groups.lua` 和 `get-jobs.lua` 中的性能隐患。

1. **修改 `includes/dal/iterate-groups.lua`**：
   - 在 `operation == 'list'` 分支中增加硬限制。
   - 增加参数 `limit` (默认比如 1000)。
   - 在遍历群组收集任务ID时，如果收集到的任务总数超过 `limit`，立即停止并返回当前结果。

2. **修改 `get-jobs.lua`**：
   - 当 `type == 'waiting'` 时，必须传递 limit 参数给 `iterateGroups`。
   - 或者：修改逻辑，如果查询 'waiting' 类型，强制要求传入 `groupId` 参数（如果业务允许），只查询特定群组的任务，避免全局扫描。如果必须全局扫描，确保 limit 生效。

这是一个性能保护措施，防止生产环境因任务过多导致阻塞。
```

---

## 任务 4：统一出队逻辑 (Refactoring)

**目标**：`complete-and-reserve-next-with-metadata.lua` 脚本中包含了一段手写是“取下一个任务”的逻辑，这与 `try-pop-next-job.lua` 重复。应统一使用标准模块。

**指令 Prompt：**
```text
请重构 `complete-and-reserve-next-with-metadata.lua` 以复用核心模块。

1. **分析现状**：
   该脚本的后半部分手动执行了：`ZPOPMIN`, `fetchJobData`, `LPUSH active`, `HSET processing` 等操作。这与 `includes/concurrency-control/try-pop-next-job.lua` 的逻辑几乎完全一致。

2. **修改 `includes/concurrency-control/try-pop-next-job.lua`**：
   - 确认该模块是否支持传入自定义的 `token` (参数中已有 `token` 字段，确认逻辑是否直接使用它)。
   - 确认是否需要增加参数以跳过某些检查（如 Chaining 场景通常不需要重新检查并发限制，因为是 1 换 1，或者利用现有的 `allowedJobId` 参数）。

3. **重构 `complete-and-reserve-next-with-metadata.lua`**：
   - 删除后半部分手动的出队逻辑。
   - 引入 `includes/concurrency-control/try-pop-next-job`。
   - 调用 `tryPopNextJob`，传入 `allowedJobId = nextJobId` (或者当前刚刚完成的任务ID，确保通过容量检查) 以及 `token = nextJobToken`。
   - 直接使用其返回的结果构建响应。

这能减少代码重复，确保出队逻辑（如幽灵任务清理、并发控制）在所有场景下保持一致。
```

---

## 验证清单 (验收标准)

在 AI 执行完上述任务后，请检查以下几点：

1.  **文件完整性**：确认 `loader.ts` 中不需要手动添加新的 include 路径（只要文件名正确，Loader 逻辑通常能自动处理，但需确认新文件被正确引用）。
2.  **死循环检查**：新引入的 `refresh-group-state` 不应产生循环依赖（A include B, B include A）。
3.  **功能测试**：
    *   **Task 1**: 完成一个任务，群组非空 -> 确认该群组仍在 Ready/Limited 队列中且顺序正确。
    *   **Task 1**: 完成群组最后一个任务 -> 确认群组被清理，且从 Ready/Limited 队列移除。
    *   **Task 3**: 在有 50 个群组，每个群组 100 个任务的环境下调用 `get-jobs waiting`，确认不会超时或返回过多数据。
    *   **Task 4**: 使用 `complete-and-reserve` 模式，确认下一个任务被正确锁定，且 `processing` 集合中有正确的 deadline 和 token。