# PRD: GroupMQ+ Lua 脚本重构与核心方法参数标准化

## 1. 背景与目的
目前的 `/lua` 根目录下存在大量功能高度重复的脚本（如各类 `get-*` 和 `promote-*`），导致维护成本高、逻辑分散。同时，`includes/` 目录下的核心方法目前使用扁平参数列表（`arg1, arg2, arg3...`），随着参数增加，调用处极易出错且难以阅读。

**本次重构的目标是：**
1.  **精简入口脚本**：合并重复逻辑，将根目录脚本数量减少 30% 以上。
2.  **标准化参数传递**：核心 `includes` 方法改为接收单一的 `options` 表（Table）对象，提升代码可读性和扩展性。

---

## 2. 核心技术规范：参数对象化 (Options Object Pattern)

所有本次 **新建** 或 **重构** 的 `includes` 目录下的一级 Lua 函数，必须放弃长参数列表，改为接收一个 `options` 表。

**规范示例：**

```lua
-- ❌ 旧方式 (不推荐)
-- local function checkQueueEmpty(ns, ignoreDelayed, ignoreStaged) ... end

-- ✅ 新方式 (要求)
-- @param options { ns: string, ignoreDelayed: string, ignoreStaged: string }
local function checkQueueEmpty(options)
    -- 1. 参数解构 (增加代码自文档化能力)
    local ns = options.ns
    local ignoreDelayed = options.ignoreDelayed
    local ignoreStaged = options.ignoreStaged

    -- 2. 业务逻辑
    if ignoreDelayed == "1" then 
        -- ...
    end
end

return checkQueueEmpty
```

**调用处变更：**
```lua
-- ❌ 旧调用
local isEmpty = checkQueueEmpty(ns, "1", "0")

-- ✅ 新调用
local isEmpty = checkQueueEmpty({
    ns = ns,
    ignoreDelayed = "1",
    ignoreStaged = "0"
})
```

---

## 3. 重构任务清单

请按照以下顺序执行重构：

### 任务一：合并读操作 (Getters)
目前存在 6 个独立的读取脚本，需合并为 2 个通用脚本。

1.  **创建 `get-queue-metrics.lua`**
    *   **替代**：`get-active-count.lua`, `get-waiting-count.lua`, `get-delayed-count.lua`。
    *   **逻辑**：接收参数 `types` (可选)。
        *   如果不传，一次性返回 `{ active: N, waiting: N, delayed: N }` 的 JSON 或 Table。
        *   如果传 `active`，仅返回 Active 数量。
    *   **依赖**：复用 `includes/dal/` 下的读取器。

2.  **创建 `get-jobs.lua`**
    *   **替代**：`get-active-jobs.lua`, `get-waiting-jobs.lua`, `get-delayed-jobs.lua`。
    *   **逻辑**：接收参数 `type` ('active'|'waiting'|'delayed'), `start`, `end`。
    *   **依赖**：根据 `type` 路由到 `read-zset` 或 `iterate-groups`。

3.  **清理**：删除上述 6 个旧文件，更新 `loader.ts`。

### 任务二：合并任务晋升 (Promotion)
目前 `promote-delayed-jobs` 和 `promote-delayed-one` 逻辑几乎一致。

1.  **创建 `promote-delayed.lua`**
    *   **替代**：`promote-delayed-jobs.lua`, `promote-delayed-one.lua`。
    *   **参数**：`ns`, `limit` (默认 -1 表示所有，传 1 表示一条)。
    *   **逻辑**：内部循环调用 `promoteDelayedJobToWaiting`。
    *   **注意**：`promoteDelayedJobToWaiting` 属于核心 include，需应用 **Options Object** 规范进行改造。

2.  **清理**：删除旧文件，更新 `loader.ts`。

### 任务三：统一完成逻辑 (Completion)
目前的完成逻辑分散在 `complete.lua`, `record-job-result.lua`, `complete-with-metadata.lua` 中，存在非原子操作风险。

1.  **确立 `complete-job.lua` 为标准**
    *   **重命名**：将 `complete-with-metadata.lua` 重命名为 `complete-job.lua`。
    *   **增强**：确保它能覆盖简单的完成场景（不需要 metadata 的情况，虽少见但需兼容）。
    *   **参数标准化**：该脚本调用的核心 include 如 `recordJobFinalization`, `removeJobFromActive`, `updateParentFlow` 需应用 **Options Object** 规范。

2.  **清理**：
    *   删除 `complete.lua` (存在状态不一致风险)。
    *   删除 `record-job-result.lua` (非原子，不推荐单独使用)。
    *   删除 `complete-and-reserve-next-with-metadata.lua` (逻辑太复杂，建议拆分为 completion + reserve 两个独立原子操作，或者保留但作为特例，暂不作为本次核心重构点，如果能合并进 `complete-job` 并通过 flag 控制 "chaining" 最好)。

### 任务四：提取 Reserve 核心逻辑
`reserve.lua` 和 `reserve-batch.lua` 有 80% 代码重复。

1.  **新建 Include: `includes/concurrency-control/try-pop-next-job.lua`**
    *   **规范**：必须使用 **Options Object** 参数风格。
    *   **逻辑**：封装“检查群组并发 -> 清理幽灵任务 -> 尝试取出的头任务 -> 移动到 Active -> 设置 Deadline”这一连串原子操作。
    *   **输入**：`{ ns, groupId, vt, token, now }`
    *   **输出**：成功返回 Job 数据字符串，失败返回 `nil` 或 错误码。

2.  **重构 `reserve.lua` 和 `reserve-batch.lua`**
    *   这两个脚本只负责外层的“遍历 Ready 队列”循环。
    *   循环内部调用 `try-pop-next-job.lua`。

---

## 4. Include 方法改造列表 (参数对象化)

在执行上述任务时，涉及到以下 Include 方法的，必须同步修改其定义和调用方式为 `options` 模式：

1.  `includes/job-lifecycle/store-job.lua`
2.  `includes/group-state/add-job-to-group.lua`
3.  `includes/delayed-handling/promote-delayed-job-complete.lua`
4.  `includes/job-lifecycle/record-job-finalization.lua`
5.  `includes/concurrency-control/try-pop-next-job.lua` (新建)

---

## 5. 交付物要求

1.  **文件变更**：删除冗余脚本，新增/修改合并后的脚本。
2.  **Loader 更新**：`loader.ts` 中的 `ScriptName` 类型定义和文件映射需同步更新。
3.  **代码风格**：所有修改过的 Lua 函数需包含详细的注释，说明 `options` 表中有哪些字段（类似 JSDoc 风格）。

**执行提示：**
请先进行 Includes 方法的封装和改造，确保底层稳固，然后再去修改顶层的 Lua 脚本。