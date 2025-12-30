# PRD: `src/lua/includes` 函数参数重构计划 (Options Object Pattern)

## 1. 缘由 (Motivation)

目前 `src/lua/includes` 下的大部分 Lua 函数采用**位置参数**（Positional Arguments）传递数据。
例如：`local function update(ns, groupId, score, isLimited)`。

**存在的问题：**
1.  **可读性差**：在调用处看到 `func(a, b, true, false, 0)` 很难理解每个参数的含义。
2.  **维护困难**：一旦需要新增参数或调整顺序，必须修改所有调用链，容易引发 Regression（回归 Bug）。
3.  **容易传错**：参数类型相同时（如多个 ID 或多个 boolean），容易传错位置且无报错。

**改造目标：**
将所有内部辅助函数统一改为接收**单一的 Options Table**。
例如：`local function update(opts)`，调用时使用 `update({ ns=ns, groupId=gid, ... })`。

---

## 2. 单个 Lua 文件改造步骤 (Refactoring Workflow)

对清单中的每个文件，请严格执行以下流程：

### 第一步：改造函数定义 (Modify Definition)
打开目标文件（例如 `src/lua/includes/common/check-queue-empty.lua`）。

**Before:**
```lua
-- check-queue-empty.lua
local function checkQueueEmpty(prefix, queueName)
  -- logic using prefix and queueName
end
return checkQueueEmpty
```

**After:**
```lua
-- check-queue-empty.lua
local function checkQueueEmpty(opts)
  -- 1. 解构参数 (Destructuring)
  local prefix = opts.prefix
  local queueName = opts.queueName

  -- 2. 注意：include 文件中不需要参数校验
  --    参数校验已在所有外层 Lua 脚本中执行
  --    include 文件只负责业务逻辑

  -- logic using prefix and queueName
end
return checkQueueEmpty
```

> **重要约定：**
> - `src/lua/includes/` 下的函数应该假设参数已被验证
> - 所有参数校验应在根目录 Lua 脚本（如 `enqueue.lua`、`reserve.lua` 等）中完成
> - Include 函数只需专注于业务逻辑实现
> - 如果该函数已经是通过 Table 传参的，则跳过该文件的改造，直接进入下一个文件的处理

### 第二步：改造调用方 (Modify Callers)
使用全局搜索（Search/Grep）查找该文件的引用路径（通常是 `@include "includes/..."`）。

**情况 A：被其他 include 文件调用**
直接修改为 Table 形式。
```lua
-- 比如在 src/lua/includes/other-func.lua 中
-- Before
checkQueueEmpty(MyPrefix, MyQueue)

-- After
checkQueueEmpty({
  prefix = MyPrefix,
  queueName = MyQueue
})
```

**情况 B：被根目录 Lua 脚本调用 (Entry Points)**
例如 `src/lua/enqueue.lua` 或 `src/lua/reserve.lua`。
这些脚本通常通过 `KEYS` 和 `ARGV` 获取外部传入的参数。
**不需要修改 TS 代码**，只需在 Lua 脚本内部将 `ARGV` 组装成 Table 传给 include 函数。

```lua
-- src/lua/root-script.lua
local prefix = KEYS[1]
local queueName = ARGV[1]

-- Before
checkQueueEmpty(prefix, queueName)

-- After
checkQueueEmpty({
  prefix = prefix,
  queueName = queueName
})
```

> ⚠️ **重要提示：避免无穷尽循环**
>
> 当处理某个文件时，**不要**在发现它内部调用了尚未改造的其他函数时就停下来去改造那些函数。
>
> **正确做法：**
> 1. 按照**目录顺序**逐个处理任务清单中的文件
> 2. 当处理 A 文件时，如果它内部调用了未改造的 B 函数，**先改造 A 文件本身**
> 3. 继续按目录顺序处理，当轮到处理 B 文件所在目录时，再一起改造 B 及其所有调用处
> 4. 这样做的好处是：避免跟随调用链无限递归，确保每个文件及其调用处都被完整处理
>
> **示例：** 处理 `promote-delayed-job-complete.lua` 时发现它调用 `updateGroupReadyLimitedState` 需要改造，
> 不要立即去处理 `updateGroupReadyLimitedState` 和它的所有调用处。应该先改造当前文件，然后继续按顺序处理下一个目录。
> 等到轮到 `group-lifecycle` 目录时，再一起改造 `updateGroupReadyLimitedState` 和它的所有调用处。

### 第三步：关于 `queue.ts` 和 `worker.ts`
*   **原则**：本次重构仅限于 **Lua 脚本内部** 的函数调用约定。
*   **结论**：只要根目录 Lua 脚本（如 `enqueue.lua`）接收 `KEYS` 和 `ARGV` 的逻辑不变，**不需要修改 TypeScript 代码**。
*   **例外**：除非你发现某个参数在 Lua 内部完全没用，决定在 TS 层移除它，否则请保持 TS -> Lua 的接口不变。

---

## 3. 任务清单 (Checklist)

请按目录结构逐步检查并打钩。

### 📂 common
- [x] **check-queue-empty.lua** ✓ 改造为 `{ ns, ignoreDelayed, ignoreStaged }` + 所有调用方已更新
- [x] **is-queue-paused.lua** ✓ 改造为 `{ ns }` + 所有调用方已更新

### 📂 concurrency-control
- [x] **get-group-active-count.lua** ✓ 改造为 `{ ns, groupId }`
- [x] **get-group-concurrency-limit.lua** ✓ 改造为 `{ ns, groupId }`
- [x] **is-group-at-capacity.lua** ✓ 改造为 `{ ns, groupId }` + 内部函数调用已更新
- [x] **try-pop-next-job.lua** ✓ 已是Options Table形式，无需改造

### 📂 dal
- [x] **iterate-groups.lua** ✓ 改造为 `{ ns, operation }` + 2处调用已更新
- [x] **read-set.lua** ✓ 改造为 `{ key, operation }` + 2处调用已更新
- [x] **read-zset.lua** ✓ 改造为 `{ key, operation, start, stop }` + 3处调用已更新

### 📂 delayed-handling
- [x] **promote-delayed-job-complete.lua** ✓ 改造为 `{ ns, jobId, delayedKey, readyKey, limitedKey }` + 2/2处调用已更新
    * ✅ promote-delayed.lua:48 已更新
    * ✅ change-delay.lua:59 已更新

### 📂 flow
- [x] **remove-child-from-parent.lua** ✓ 改造为 `{ ns, parentId, childId, readyKey, limitedKey }` + 2/2处调用已更新
    * ✅ clean-status.lua:65 已更新
    * ✅ delete-job-completely.lua:63 已更新
- [x] **update-parent-flow.lua** ✓ 改造为 `{ ns, parentId, childId, status, resultOrError, timestamp, readyKey, limitedKey }` + 2/2处调用已更新
    * ✅ complete-and-reserve-next-with-metadata.lua:68 已更新
    * ✅ complete-job.lua:107 已更新

### 📂 ghost-cleanup
- [x] **detect-ghost-tasks.lua** ✓ 改造为 `{ ns, groupId, processingKey }` + 2/2处调用已更新
    * ✅ reserve-atomic.lua:34 已更新
    * ✅ try-pop-next-job.lua:47 已更新

### 📂 group-analysis
- [x] **analyze-group-poisoning.lua** ✓ 改造为 `{ ns, groupId }` + 1/1处调用已更新
    * ✅ cleanup-poisoned-group.lua:30 已更新

### 📂 group-lifecycle
- [x] **cleanup-if-group-empty.lua** ✓ 改造为 `{ ns, groupId }` + 4/4处调用已全部更新
    * ✅ complete-job.lua:102 已更新
    * ✅ clean-status.lua:52 已更新
    * ✅ delete-job-completely.lua:51 已更新
    * ✅ change-delay.lua:56 已更新
- [x] **update-group-ready-limited-state.lua** ✓ 改造为 `{ ns, groupId, readyKey, limitedKey, headScore }` + 11+处调用已全部更新
    *   🌟 **Critical**: 此核心函数参数较多且调用极其频繁，修改时已格外小心 ✓

### 📂 group-state
- [x] **add-job-to-group.lua** ✓ 调用方已更新为 `{ ns, groupId, readyKey, limitedKey, headScore }`
- [ ] **remove-job-from-active.lua**

### 📂 group-status
- [ ] **get-group-head-job.lua**

### 📂 job-lifecycle
- [ ] **delete-job-completely.lua**
- [x] **move-to-dead-letter.lua** ✓ 调用方已更新为 `{ ns, groupId, readyKey, limitedKey, headScore }`
- [ ] **record-job-finalization.lua**
- [ ] **store-job.lua**

### 📂 job-recovery
- [x] **recover-single-job.lua** ✓ 改造为 `{ ns, jobId, groupId, jobScore, delayUntil, now, readyKey, limitedKey, processingKey }` + 调用方已更新

### 📂 retry-handling
- [x] **handle-job-retry-with-backoff.lua** ✓ 改造为 `{ ns, jobId, groupId, token, backoffMs }`

### 📂 security
- [ ] **verify-token.lua**

### 📂 stalled-recovery
- [x] **recover-stalled-jobs-complete.lua** ✓ 调用方已更新为 `{ ns, groupId, readyKey, limitedKey, headScore }`
- [x] **try-trigger-stalled-check.lua** ✓ 调用方已更新为 `{ ns, groupId, readyKey, limitedKey, headScore }`

---

## 4. 进度概览 (Progress Overview)

### 已完成阶段 ✅ (16/27)

**第一阶段 - 关键路径函数重构** (已完成)
- ✅ common 目录 (2/2)
- ✅ concurrency-control 目录 (4/4)
- ✅ group-lifecycle 关键函数: `updateGroupReadyLimitedState` (核心函数，11+处调用)
- ✅ job-recovery 目录 (1/1)
- ✅ retry-handling 目录 (1/1)
- ✅ delayed-handling 目录 (1/1)
- ✅ flow 目录 (2/2)
- ✅ ghost-cleanup 目录 (1/1) ⭐ 本次完成
- ✅ group-analysis 目录 (1/1)
- ✅ group-lifecycle 目录 (2/2) ⭐ 本次完成（cleanup-if-group-empty.lua + 4处调用）
- ✅ group-state 调用方 (1/1)
- ✅ job-lifecycle 调用方 (1/1)
- ✅ stalled-recovery 调用方 (2/2)

**已更新的根目录 Lua 脚本** (10个)
- is-empty.lua, reserve.lua, reserve-atomic.lua, reserve-batch.lua
- complete-job.lua, complete-and-reserve-next-with-metadata.lua
- promote-staged.lua, cleanup.lua, cleanup-poisoned-group.lua, test-merge.lua

### 待完成阶段 (12/27)

- [ ] dal 目录 (3/3)
- [ ] group-lifecycle: cleanup-if-group-empty.lua (1/1)
- [ ] group-state: remove-job-from-active.lua (1/1)
- [ ] group-status 目录 (1/1)
- [ ] job-lifecycle 其他函数 (3/4)
- [ ] security 目录 (1/1)

### 关键改动统计

| 指标 | 数值 |
|------|------|
| 修改的文件 | 28个 |
| 改造的内部函数 | 11个 |
| 更新的函数调用方 | 21+处 |
| 完成度 | 56% (15/27) |