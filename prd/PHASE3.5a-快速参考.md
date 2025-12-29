# Phase 3.5a - 快速参考卡片

## 🎯 状态：✅ 完成

**时间**: 2025-12-29
**完成度**: 100% (第1批)
**下一步**: 启动新会话进行 Phase 3.5b

---

## 🔑 关键要点 (必读)

### 1. Include 文件设计 ⭐

**重要**: Includes 文件**不要有 return 语句**！
```lua
-- ✅ 正确
local function updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
  -- 函数体
end

-- ❌ 错误
local function updateGroupReadyLimitedState(...)
end
return updateGroupReadyLimitedState  -- 删除这行
```

### 2. Include 路径 ⭐

**规则**: 所有 include 都用 `"includes/..."` 格式
```lua
-- ✅ 正确
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- ❌ 错误（相对路径）
--- @include "../concurrency-control/is-group-at-capacity"
```

### 3. 替换模式

**步骤**:
1. 找到重复代码块
2. 在脚本顶部添加 `@include` 指令
3. 用单行函数调用替换
4. 验证参数顺序正确

---

## 📋 第1批完成情况

### 块1: updateGroupReadyLimitedState (16处) ✅

**函数**:
```lua
updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
```

**修改文件** (12个):
- reserve.lua (3处)
- reserve-batch.lua (3处)
- complete-with-metadata.lua (2处)
- change-delay.lua (1处)
- retry.lua (1处)
- dead-letter.lua (1处)
- check-stalled.lua (1处)
- 其他 5 个文件 (5处)

**测试**: ✅ 142个全部通过

---

## 🚀 第2批计划

### 块4: handleFlowChildCompletion (5处)
- 文件: `src/lua/includes/flow-handling/handle-flow-child-completion.lua`
- 脚本: complete-with-metadata, record-job-result, remove, clean-status, enqueue-flow
- 工作量: 🔴 高

### 块5: recoverStalledJobsCompletely (5处)
- 文件: `src/lua/includes/stalled-recovery/recover-stalled-jobs-complete.lua`
- 脚本: reserve, reserve-batch, check-stalled, cleanup
- 工作量: 🔴 高

### 块6: promoteDelayedJobToWaiting (3处)
- 文件: `src/lua/includes/delayed-handling/promote-delayed-job-complete.lua`
- 脚本: promote-delayed-one, promote-delayed-jobs, change-delay
- 工作量: 🟡 中

---

## ⚠️ 常见错误速查表

| 错误 | 原因 | 修复 |
|-----|------|------|
| Include file not found | 路径错误或相对路径 | 改为 `includes/...` |
| 脚本提前返回 | Include 文件有 return | 删除 return 语句 |
| 参数不匹配 | 参数顺序错或遗漏 | 检查函数签名 |
| Redis 操作错误 | 改变了操作顺序 | 保持原有顺序 |

---

## 📄 参考文档

1. **完整总结**: `/prd/lua重构Phase3.5a-完成总结与交接.md`
2. **块定义**: `/prd/lua重构Phase3.5-大逻辑块提取完成.md`
3. **实施指南**: `/prd/lua重构Phase3.5a-替换实施指南.md`

---


**Next Session**: 基于此快速参考启动 Phase 3.5b
