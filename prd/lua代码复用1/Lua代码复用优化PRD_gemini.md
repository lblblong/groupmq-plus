这是一份为 AI 编码助手（如 Cursor、Windsurf、GitHub Copilot）量身定制的**产品需求文档 (PRD) 与实施指南**。

你可以直接将以下内容**作为一个整体**发送给 AI。它包含了上下文、设计规范、新模块的伪代码定义以及严格的执行步骤。

---

# 🏗️ Technical PRD: GroupMQ+ Lua 核心逻辑重构

**Version**: 1.0
**Context**: 本项目是一个基于 Redis 的高性能消息队列 (`GroupMQ+`)。核心逻辑主要由 `src/lua` 目录下的 Lua 脚本实现。
**Objective**: 重构 `src/lua` 下的代码，消除重复逻辑（Code Duplication），标准化核心流程，提升可维护性。
**Constraint**: 必须严格遵循现有的 `@include` 机制。

---

## 1. 核心需求概览

我们需要将散落在各个主脚本（Entry Scripts）中的通用逻辑提取到 `lua/includes/` 目录下的复用模块中。主要涉及四个领域：

1.  **Flow/DAG 父任务更新**: 子任务完成时更新父任务状态的逻辑。
2.  **Token 验证**: 验证 Worker 持有的令牌是否有效。
3.  **群组清理**: 当群组为空时清理元数据，或更新其在 Ready/Limited 集合中的状态。
4.  **Stalled Check 标准化**: 修复 `reserve.lua` 中内联的陈旧逻辑，强制使用标准模块。
5.  **数据读取标准化**: 统一使用 `getJobFullData`。

---

## 2. 新模块定义 (Technical Specifications)

### 2.1 模块 A: `update-parent-flow.lua`
*   **路径**: `lua/includes/flow/update-parent-flow.lua`
*   **依赖**: `includes/group-lifecycle/update-group-ready-limited-state`
*   **逻辑描述**:
    ```lua
    function updateParentFlow(ns, parentId, childId, status, resultOrError, now)
      -- 1. 将子任务结果写入 {ns}:flow:results:{parentId} (JSON: {status, data})
      -- 2. 对 {ns}:job:{parentId} 执行 HINCRBY flowRemaining -1
      -- 3. 如果 remaining <= 0:
      --    a. 检查父任务状态是否为 'waiting-children'
      --    b. 若是，更新为 'waiting'
      --    c. 将父任务加入群组 ZSET (使用 score 或 now)
      --    d. 调用 updateGroupReadyLimitedState 更新群组在 ready/limited 队列的位置
    end
    ```

### 2.2 模块 B: `verify-token.lua`
*   **路径**: `lua/includes/common/verify-token.lua`
*   **逻辑描述**:
    ```lua
    function verifyToken(ns, jobId, token)
      -- 1. 如果 token 为 nil/false，返回 true (向后兼容)
      -- 2. 获取 {ns}:processing:{jobId} 中的 'token' 字段
      -- 3. 如果 Redis 中无 token (任务已丢失锁)，返回 false
      -- 4. 返回 (storedToken == token)
    end
    ```

### 2.3 模块 C: `cleanup-if-group-empty.lua`
*   **路径**: `lua/includes/group-lifecycle/cleanup-if-group-empty.lua`
*   **依赖**: `includes/group-lifecycle/update-group-ready-limited-state`
*   **逻辑描述**:
    ```lua
    function cleanupIfGroupEmpty(ns, groupId, readyKey, limitedKey)
      -- 1. 获取 ZCARD (gZ) 和 Meta Count (HGET count)
      -- 2. 如果 ZCARD==0 且 MetaCount<=0:
      --    执行物理清理 (DEL gZ, active, meta, buffer; REM from groups, ready, limited, buffering)
      --    返回 true
      -- 3. 否则:
      --    获取 gZ 的 headScore
      --    调用 updateGroupReadyLimitedState
      --    返回 false
    end
    ```

---

## 3. 实施计划 (Implementation Steps)

请作为一名资深的 Redis/Lua 工程师，按以下顺序逐步执行重构。

### Phase 1: 基础设施建设 (Infrastructure)

#### Step 1: 创建 Token 验证模块
1.  创建文件 `lua/includes/common/verify-token.lua`。
2.  实现上述 [2.2 模块 B] 的逻辑。
3.  **Refactor**: 修改以下文件，使用 `@include "includes/common/verify-token"` 并替换原有的 `if token ~= storedToken` 逻辑：
    *   `lua/heartbeat.lua`
    *   `lua/dead-letter.lua`
    *   `lua/includes/retry-handling/handle-job-retry-with-backoff.lua`
    *   `lua/record-job-result.lua`
    *   `lua/complete-with-metadata.lua`
    *   `lua/complete-and-reserve-next-with-metadata.lua`

#### Step 2: 修复 `reserve.lua` (Critical Fix)
1.  打开 `lua/reserve.lua`。
2.  定位到 Lines 37-83 (大致范围) 的内联 Stalled Job Check 逻辑。
3.  **Refactor**: 删除这段代码，改为引入并调用 `@include "includes/stalled-recovery/recover-stalled-jobs-complete"`。
4.  **注意**: 确保调用方式与 `lua/reserve-batch.lua` 中的用法一致 (参数适配)。

### Phase 2: 核心流程抽象 (Core Abstraction)

#### Step 3: 创建 Flow 父任务更新模块
1.  创建文件 `lua/includes/flow/update-parent-flow.lua`。
2.  实现上述 [2.1 模块 A] 的逻辑。确保引入了依赖模块。
3.  **Refactor**: 修改 `lua/record-job-result.lua`，将其中处理父任务更新的几十行代码替换为调用新函数 `updateParentFlow`。

#### Step 4: 应用 Flow 模块到其余脚本
1.  **Refactor**: 将 `lua/complete-with-metadata.lua` 中的 Flow 逻辑替换为调用 `updateParentFlow`。
2.  **Refactor**: 将 `lua/complete-and-reserve-next-with-metadata.lua` 中的 Flow 逻辑替换为调用 `updateParentFlow`。
3.  **Refactor**: 检查 `lua/includes/job-lifecycle/delete-job-completely.lua`。如果逻辑匹配（递减 flowRemaining 并唤醒父任务），也进行替换。如果不完全匹配，请保留原样但添加注释说明差异。

#### Step 5: 创建并应用群组清理模块
1.  创建文件 `lua/includes/group-lifecycle/cleanup-if-group-empty.lua`。
2.  实现上述 [2.3 模块 C] 的逻辑。
3.  **Refactor**: 修改以下文件，替换原本分散的清理逻辑：
    *   `lua/complete.lua`
    *   `lua/complete-with-metadata.lua`
    *   `lua/dead-letter.lua`
    *   `lua/clean-status.lua` (注意：clean-status 逻辑可能略有不同，请仔细检查。如果 clean-status 需要保留 `delay` 状态的特殊处理，可以不替换或仅部分替换)。

### Phase 3: 标准化与收尾 (Standardization)

#### Step 6: 统一任务数据获取
1.  目标文件：`lua/reserve.lua`, `lua/reserve-batch.lua`, `lua/reserve-atomic.lua`。
2.  **Action**:
    *   引入 `@include "includes/job-data/get-job-full-data"`。
    *   替换原本的手动 `HMGET` 调用。
    *   **关键点**: `getJobFullData` 返回的是数组。请确保替换后，变量解构（如 `local id, groupId, payload... = unpack(jobData)`）的顺序与原逻辑完全一致，且能正确处理可能新增的字段（如 `isFlowParent`）。

---

## 4. 验证清单 (Verification Checklist)

AI 在执行完代码修改后，请自查以下几点：

1.  **Syntax Check**: 所有 Lua 脚本语法正确，变量名无冲突。
2.  **Include Check**: 所有新引入的 `@include` 路径正确，没有拼写错误。
3.  **Logic Consistency**: 提取后的逻辑与原逻辑在边界条件（如 null check, 0 check）上保持一致。
4.  **Token Compatibility**: 确保 `verifyToken` 能够处理 `token` 为 `nil` 的情况（向后兼容）。