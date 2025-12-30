现在，我们进入 **Phase 4：数据获取与只读操作 (Read-Only Operations)**。
虽然只读操作看起来风险较低，但它们目前存在大量的代码重复（尤其是 `get-*-jobs.lua` 系列），且直接暴露了底层数据结构（如 `ZRANGE`, `LLEN`）。如果未来我们修改了底层的存储结构（例如改变了 ZSET 的 Score 算法），这些只读脚本将全部失效。

以下是 **Phase 4 重构 PRD**，旨在统一数据查询层，实现**“读写分离”的逻辑封装**。

---

# PRD: GroupMQ Lua 脚本模块化重构方案 (Phase 4)

## 1. 背景与目的

前三个阶段主要解决了“写操作”的逻辑复用。然而，GroupMQ 还有大量用于监控和管理的“只读脚本”（如 `get-active-jobs`, `get-waiting-count` 等）。
这些脚本直接操作 Redis Key（如直接 `ZRANGE processingKey`），这导致：

1.  **数据结构耦合**：上层业务逻辑与底层 Redis 数据结构强绑定。
2.  **代码重复**：获取 Waiting Jobs 和 Delayed Jobs 的逻辑高度相似，仅 Key 不同。
3.  **不一致风险**：如果 Phase 2 修改了任务存储方式，这些只读脚本可能读取到错误数据。

**目标**：构建统一的 **Data Access Layer (DAL)** 模块，所有的数据查询都通过 DAL 进行，屏蔽底层 Redis 命令。

## 2. 重构范围

本次重构聚焦于 **状态查询 (Status Query)**、**任务列表获取 (List Retrieval)** 以及 **统计信息 (Statistics)**。

涉及修改的主脚本：

- `get-active-count.lua` / `get-active-jobs.lua`
- `get-delayed-count.lua` / `get-delayed-jobs.lua`
- `get-waiting-count.lua` / `get-waiting-jobs.lua`
- `get-unique-groups-count.lua` / `get-unique-groups.lua`
- `is-empty.lua`

## 3. 新增模块定义 (Implementation Details)

请在 `includes/` 下创建以下新模块（建议创建新目录 `includes/dal/`）：

### 3.1. 集合读取器 (Set Reader)

**文件路径**: `includes/dal/read-zset.lua`
**功能**: 封装对 ZSET 的读取操作（Count 和 Range）。
**伪代码**:

```lua
-- 参数: key, type ('count' | 'range'), start, stop
-- if type == 'count': return ZCARD key
-- if type == 'range': return ZRANGE key start stop
```

### 3.2. 群组迭代器 (Group Iterator)

**文件路径**: `includes/dal/iterate-groups.lua`
**功能**: 封装“遍历所有群组并聚合数据”的逻辑（这是 `get-waiting-*` 的核心痛点）。
**伪代码**:

```lua
-- 参数: ns, operation ('count' | 'list')
-- 1. SMEMBERS groupsKey
-- 2. 遍历每个 gid:
--    构造 groupKey
--    if operation == 'count': total += ZCARD groupKey
--    if operation == 'list': append(jobs, ZRANGE groupKey)
-- 3. 返回 total 或 jobs 列表
```

### 3.3. 队列状态检查器

**文件路径**: `includes/common/check-queue-empty.lua`
**功能**: 封装 `is-empty.lua` 的逻辑，提供一个统一的“空状态”检查函数。
**伪代码**:

```lua
-- 参数: ns
-- 1. 检查 processing ZCARD
-- 2. 检查 delayed ZCARD
-- 3. 检查 ready ZCARD
-- 4. 检查 groups SMEMBERS -> 遍历 ZCARD
-- 返回: boolean (true if all empty)
```

## 4. 现有脚本修改计划

### 4.1. 重构 `get-*-count.lua` 和 `get-*-jobs.lua`

- **Active/Delayed**:
  - **引入**: `includes/dal/read-zset`
  - **修改**: 替换直接的 `ZCARD/ZRANGE` 调用。
- **Waiting**:
  - **引入**: `includes/dal/iterate-groups`
  - **修改**: 将原本显式的 `for` 循环遍历替换为函数调用。
  - `get-waiting-count.lua` -> `return iterateGroups(ns, 'count')`
  - `get-waiting-jobs.lua` -> `return iterateGroups(ns, 'list')`

### 4.2. 重构 `get-unique-groups-*.lua`

- **引入**: 通用 Set 读取逻辑（可复用 `read-zset` 或直接保留简单命令，视一致性要求而定。建议如果逻辑仅 1 行且极其稳定，可暂不封装；但为了风格统一，建议封装）。

### 4.3. 重构 `is-empty.lua`

- **引入**: `includes/common/check-queue-empty`
- **修改**: 将脚本内容替换为单行调用。
- **意义**: 未来如果增加了新的状态（如 `staged` 已经在 Phase 2 加入但 `is-empty` 可能漏掉了），只需修改这个 include 文件，所有相关检查都会生效。

## 5. 执行提示 (Prompt for AI)

> **给 AI 的指令：**
>
> 请执行 GroupMQ 的 Phase 4 重构。目标是统一“只读查询”脚本的底层逻辑，建立 Data Access Layer。
>
> 1.  **创建 DAL**: 创建 `includes/dal/` 目录，并实现 `read-zset.lua` 和 `iterate-groups.lua`。
> 2.  **创建 Common**: 创建 `includes/common/check-queue-empty.lua`。注意检查它是否涵盖了所有状态（Processing, Delayed, Ready, Groups, **以及新的 Staged**）。
> 3.  **重构 Getters**: 重构所有的 `get-*.lua` 脚本。
> 4.  **重构 IsEmpty**: 重构 `is-empty.lua`。
> 5.  **展示结果**: 请展示重构后的 `get-waiting-jobs.lua` 和 `is-empty.lua`。
