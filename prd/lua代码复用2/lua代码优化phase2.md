这是一个**收尾阶段的重构 PRD**，旨在解决上一轮核查中发现的遗漏点，并进一步优化代码复用性。

---

# PRD: Refactoring Phase 2 - Finalization & Cleanup

## 1. 背景与目标 (Background & Goal)
在第一阶段重构中，绝大多数辅助函数已成功迁移至 `Options Object` 模式。
**本阶段目标**：
1.  **补全遗漏**：改造尚未修改的 `add-job-to-group.lua` 及其所有调用方。
2.  **逻辑复用**：在 `enqueue-batch.lua` 和 retry 逻辑中，替换手动实现的 Redis 操作为已有的核心辅助函数，确保逻辑统一（DRY原则）。
3.  **依赖修复**：修复 `test-merge.lua` 中可能存在的断链引用。

---

## 2. 改造步骤 (Step-by-Step Guide)

### 任务 A: 改造 `add-job-to-group.lua` (Critical)
此函数是任务入队的核心路由逻辑，涉及文件较多，需原子性修改。

**2.1 修改定义**
*   **文件**: `src/lua/includes/group-state/add-job-to-group.lua`
*   **动作**: 将位置参数改为 `opts` 对象。
*   **Code Change**:
    ```lua
    -- Before
    local function addJobToGroup(ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs)
      -- ...
    end

    -- After
    local function addJobToGroup(opts)
      local ns = opts.ns
      local groupId = opts.groupId
      local jobId = opts.jobId
      local score = opts.score
      local delayUntil = opts.delayUntil
      local orderMs = opts.orderMs
      local orderingDelayMs = opts.orderingDelayMs
      -- ...
    end
    ```

**2.2 修改调用方**
需同时修改以下 3 个入口文件中的调用：
1.  **`src/lua/enqueue.lua`**:
    *   将 `addJobToGroup(ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs)` 改为 table 形式。
2.  **`src/lua/enqueue-batch.lua`**:
    *   同上。
3.  **`src/lua/enqueue-flow.lua`**:
    *   将 `addJobToGroup(ns, childGroupId, childId, childScore, childDelayUntil, childOrderMs, 0)` 改为 table 形式。

---

### 任务 B: 优化 `enqueue-batch.lua` (Best Practice)
目前批量入队脚本在最后更新群组状态时，手动复制了状态判断逻辑，建议复用标准函数。

*   **文件**: `src/lua/enqueue-batch.lua`
*   **步骤 1**: 在文件顶部添加引用。
    ```lua
    --- @include "includes/group-lifecycle/update-group-ready-limited-state"
    ```
    *(注：原文件只有 `store-job`, `add-job-to-group`, `is-group-at-capacity`)*

*   **步骤 2**: 替换底部的 `for` 循环逻辑。
    *   **Before**: 手动判断 `limitedKey`，手动比较 `currentActive` 和 `limit`，手动 `ZADD`。
    *   **After**:
        ```lua
        -- Batch update ready queue for all affected groups
        for groupId, _ in pairs(groupsToUpdate) do
          local gZ = ns .. ":g:" .. groupId
          local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
          if head and #head >= 2 then
            local headScore = tonumber(head[2])
            -- 直接调用核心辅助函数
            updateGroupReadyLimitedState({
              ns = ns,
              groupId = groupId,
              readyKey = readyKey,
              limitedKey = limitedKey,
              headScore = headScore
            })
          end
        end
        ```

---

### 任务 C: 优化重试逻辑 (Consistency)
重试逻辑中直接操作了 Redis List `LREM`，应统一使用 `removeJobFromActive` 以便未来统一维护（如处理竞态条件）。

*   **文件**: `src/lua/includes/retry-handling/handle-job-retry-with-backoff.lua`
*   **步骤 1**: 添加引用。
    ```lua
    --- @include "includes/group-state/remove-job-from-active"
    ```
*   **步骤 2**: 替换 `LREM` 调用。
    *   **Before**: `redis.call("LREM", groupActiveKey, 1, jobId)`
    *   **After**:
        ```lua
        removeJobFromActive({
          ns = ns,
          groupId = groupId,
          jobId = jobId
        })
        ```

---

### 任务 D: 修复测试脚本 (Fix) ✅ 已完成
`test-merge.lua` 引用了一个未见的文件。

*   **文件**: `src/lua/test-merge.lua`
*   **动作**: 检查 `includes/group-status/get-group-job-count.lua` 是否存在。
    *   如果**存在**：请确保它也改为 `options` 模式，并更新 `test-merge.lua` 中的调用。
    *   如果**不存在**（根据之前的文件列表似乎不存在）：请**删除** `test-merge.lua` 中相关的引用行和测试代码，防止运行报错。

**✅ 完成情况**:
- 确认 `includes/group-status/get-group-job-count.lua` 不存在
- 确认 `test-merge.lua` 是纯测试脚本，无实际用途
- 已删除 `src/lua/test-merge.lua`

---