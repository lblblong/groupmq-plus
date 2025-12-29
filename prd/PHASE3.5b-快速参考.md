# Phase 3.5b - 快速参考卡片

## 🎯 状态：✅ 完成

**时间**: 2025-12-29
**完成度**: 100% (第2批)
**下一步**: 启动新会话进行 Phase 3.5c

---

## 🔑 关键要点 (必读)

### 1. 块4 (handleFlowChildCompletion) 的限制 ⭐

**重要**: 块4只适用于**子任务完成/失败**时的处理！

```lua
-- ✅ 使用场景：子任务完成时
handleFlowChildCompletion(ns, jobId, parentId, status, resultOrError)

-- ❌ 不使用场景：删除子任务
-- remove.lua 和 clean-status.lua 中的删除逻辑不能用块4替换
```

**原因**:
- 块4需要存储子任务结果
- 删除场景需要删除已存储的结果，完全不同的操作

### 2. 块5 (recoverStalledJobsCompletely) 的两个版本 ⭐

**完整版** (在include文件中):
- 包含失败判断逻辑
- 返回处理结果数组
- 用于非热路径：check-stalled.lua

**简化版** (内联在脚本中):
- 只处理恢复，不判断失败
- 用于热路径优化：reserve.lua、reserve-batch.lua、cleanup.lua
- 保持不变

### 3. 块6 (promoteDelayedJobToWaiting) 的灵活使用 ⭐

**多种使用模式**:
- promote-delayed-one.lua: 查询1个 → 调用块6 → 转换返回值为数字
- promote-delayed-jobs.lua: 批量查询 → 循环调用块6 → 统计成功数
- change-delay.lua: 条件判断 → 调用块6 → 继续原有流程

**返回值处理**:
```lua
local result = promoteDelayedJobToWaiting(...)
if result == "promoted" then
  -- 成功
elseif result == "not-found" then
  -- 任务不存在
else
  -- 数据无效或其他情况
end
```

---

## 📋 第2批完成情况

### 块4: handleFlowChildCompletion (2处) ✅

**函数**:
```lua
handleFlowChildCompletion(ns, jobId, parentId, status, resultOrError)
```

**修改文件** (2个):
- complete-with-metadata.lua (1处)
- record-job-result.lua (1处)

**未修改** (理由):
- remove.lua (删除场景，不适用)
- clean-status.lua (删除场景，不适用)
- enqueue-flow.lua (创建场景，无需替换)

### 块5: recoverStalledJobsCompletely (1处) ✅

**函数**:
```lua
recoverStalledJobsCompletely(ns, now, gracePeriod, maxStalledCount)
```

**修改文件** (1个):
- check-stalled.lua (1处完整替换，约90行简化为2行)

**未修改** (理由):
- reserve.lua (热路径，保留简化版)
- reserve-batch.lua (热路径，保留简化版)
- cleanup.lua (热路径，保留简化版)

### 块6: promoteDelayedJobToWaiting (3处) ✅

**函数**:
```lua
promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)
```

**修改文件** (3个):
- promote-delayed-one.lua (1处)
- promote-delayed-jobs.lua (1处)
- change-delay.lua (1处，else分支)

**测试**: ✅ 全部通过，零回归

---

## 📊 成果统计

| 指标 | 第1批 | 第2批 | 合计 |
|-----|------|------|------|
| 完成的块数 | 1 | 3 | 4 |
| 替换位置 | 16 | 6 | 22 |
| 修改脚本数 | 12 | 6 | 18 |
| 代码精简 | ~130行 | ~120行 | ~250行 |
| 完成度 | 35% | 65% | 65% |

---

## 🚀 第3批计划

### 块7: handleJobRetryWithBackoff (1处)
- 文件: `src/lua/includes/retry-handling/handle-job-retry-with-backoff.lua`
- 脚本: retry.lua
- 工作量: 🟢 低

### 块8: recordJobFinalization (2处)
- 文件: `src/lua/includes/job-lifecycle/record-job-finalization.lua`
- 脚本: complete-with-metadata, record-job-result
- 工作量: 🟡 中

### 块9: deleteJobCompletely (1处)
- 文件: `src/lua/includes/job-lifecycle/delete-job-completely.lua`
- 脚本: remove.lua
- 工作量: 🟡 中

### 块10: enqueueJobWithIdempotence (2处)
- 文件: `src/lua/includes/job-lifecycle/enqueue-job-with-idempotence.lua`
- 脚本: enqueue, enqueue-batch
- 工作量: 🔴 高

---

## ⚠️ 常见错误速查表

| 错误 | 原因 | 修复 |
|-----|------|------|
| Include file not found | 路径错误或相对路径 | 改为 `includes/...` |
| 脚本提前返回 | Include 文件有 return | 删除 return 语句 |
| 参数不匹配 | 参数顺序错或遗漏 | 检查函数签名 |
| 返回值未处理 | 函数返回字符串但调用方期望数字 | 添加返回值转换逻辑 |
| Redis 操作重复 | 块函数和调用方都执行了相同操作 | 避免重复执行 |
| 热路径性能下降 | 用完整块函数替换了简化版 | 保留简化版在热路径中 |

---

## 📄 参考文档

1. **第1批总结**: `/prd/lua重构Phase3.5a-完成总结与交接.md`
2. **第2批总结**: `/prd/lua重构Phase3.5b-完成总结与接下来计划.md`
3. **块定义**: `/prd/lua重构Phase3.5-大逻辑块提取完成.md`
4. **实施指南**: `/prd/lua重构Phase3.5a-替换实施指南.md`

---

## 💡 关键洞察

1. **不同场景需要不同的块**:
   - 完成/失败 ≠ 删除 ≠ 创建
   - 设计块函数时需要明确应用场景

2. **热路径优化 vs 代码复用**:
   - 热路径可以保留简化版本以保证性能
   - 非热路径可以用完整块函数以提高复用度

3. **返回值处理的重要性**:
   - 不同块函数的返回值类型不同（数字、字符串、数组）
   - 调用方需要根据实际需求进行适当的转换

4. **Include路径规范很关键**:
   - 所有include都使用 `includes/...` 格式
   - 即使在include文件中也遵循相同规范

---

**Next Session**: 基于此快速参考启动 Phase 3.5c
