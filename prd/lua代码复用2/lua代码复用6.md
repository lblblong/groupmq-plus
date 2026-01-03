# 实施文档：Redis Lua 脚本库 - 最终代码精简与优化

## 1. 项目背景与上下文
本项目是一个高性能、基于 Redis Lua 脚本的分布式任务队列核心引擎。代码采用了模块化设计，通过 Loader 机制处理 `@include` 依赖。

**核心架构说明：**
- **状态管理**：群组（Group）在 `Ready`（就绪）和 `Limited`（限流）集合之间的流转是核心逻辑。
- **模块化**：核心逻辑已被封装在 `includes/` 目录下（如 `updateGroupReadyLimitedState` 和 `refreshGroupState`）。
- **当前现状**：核心模块非常健壮，支持自动获取数据，但调用方（Call Sites）仍保留了历史遗留的防御性代码（如手动检查 `ZRANGE`），导致逻辑冗余。

## 2. 实施目标
本次变更旨在进行代码库的**“最后一公里”清理**。
1.  **消除冗余 (DRY)**：移除调用方不必要的手动数据获取，完全信任核心模块的内部逻辑。
2.  **清理死代码**：移除未使用的 Redis Key 定义。
3.  **统一模式**：确保所有状态刷新逻辑统一使用 `refreshGroupState` 模块。

---

## 3. 详细变更规范 (Detailed Specifications)

### 任务 A：移除冗余的 ZRANGE 检查
**原理**：`includes/group-lifecycle/update-group-ready-limited-state.lua` 模块内部已经包含了 `if not headScore then fetch... end` 的逻辑。调用方无需再手动查询 `ZRANGE`。

#### 变更点 A.1: `includes/group-state/add-job-to-group.lua`
*   **目标**：CASE 3 (Job is ready) 分支。
*   **动作**：删除 `redis.call("ZRANGE", ...)` 和 `if head ...` 块。直接调用 `updateGroupReadyLimitedState`。

#### 变更点 A.2: `promote-staged.lua`
*   **目标**：在循环内部，将任务从 Stage 移回 Group 后。
*   **动作**：删除 `redis.call("ZRANGE", ...)` 检查，直接调用 `updateGroupReadyLimitedState`。

#### 变更点 A.3: `includes/stalled-recovery/recover-stalled-jobs-complete.lua`
*   **目标**：在 "recovered" 分支（恢复到 waiting 状态）。
*   **动作**：删除 `redis.call("ZRANGE", ...)` 检查，直接调用 `updateGroupReadyLimitedState`。
    *   *注意*：对于 "delayed" 分支，如果逻辑中也包含手动检查，同样适用此优化；但主要关注 "recovered" 分支。

#### 代码变更示例 (Pattern)：

**Before (旧代码):**
```lua
local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
if head and #head >= 2 then
  local headScore = tonumber(head[2])
  updateGroupReadyLimitedState({ ..., headScore = headScore })
end
```

**After (新代码):**
```lua
-- 模块内部会自动获取 headScore
updateGroupReadyLimitedState({ 
  ns = ns, 
  groupId = groupId, 
  readyKey = readyKey, 
  limitedKey = limitedKey 
})
```

---

### 任务 B：简化 `Complete-and-Reserve` 逻辑
**文件**：`complete-and-reserve-next-with-metadata.lua`
**原理**：`refreshGroupState` 模块封装了“如果空则清理，如果不空则更新状态”的完整逻辑。

*   **位置**：脚本底部，在成功获取 `nextJob` 并处理完逻辑后。
*   **现状**：当前代码手动进行了 `ZRANGE` 检查，如果不为空则调用 `refreshGroupState`。
*   **变更**：无条件直接调用 `refreshGroupState`。
    *   *理由*：即使刚取出的任务是最后一个，群组变空了，`refreshGroupState` 内部的 `cleanupIfGroupEmpty` 也会正确处理清理工作。现在的 `if nextHead` 判断反而可能导致刚刚变空的群组没有被及时清理。

---

### 任务 C：清理死代码
**文件**：`includes/group-lifecycle/cleanup-if-group-empty.lua`
**原理**：项目从未写入过 `buffer` 相关的 Key。

*   **动作**：
    1. 删除变量定义：`local groupBufferKey = ns .. ":buffer:" .. groupId`
    2. 删除清理操作：`redis.call("DEL", groupBufferKey)`

---

## 4. 验证标准 (Acceptance Criteria)
在代码修改完成后，请自我检查以下几点：
1.  **逻辑完整性**：确认 `updateGroupReadyLimitedState` 的调用参数正确（包含 `ns`, `groupId`, `readyKey`, `limitedKey`）。
2.  **安全性**：确认移除 `if head` 判断后，不会因为群组为空而报错（`updateGroupReadyLimitedState` 内部应有 `if not head or #head < 2 then return end` 的保护，请复查该文件确认）。
3.  **整洁度**：代码行数应显著减少，逻辑流更通顺。

---

**致 AI 助手**：
请读取当前的 codebase（repomix-output.xml），根据上述规范，**一步到位**完成所有文件的修改。不需要为了向后兼容保留旧的注释，直接提供优化后的、干净的代码。