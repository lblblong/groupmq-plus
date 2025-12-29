# Lua 重构 Phase 3.5a: 大逻辑块替换实施指南

**Date**: 2025-12-29
**Status**: 📋 替换准备就绪
**负责**: 新AI窗口 - 执行脚本替换
**参考**: 见 `lua重构Phase3.5-大逻辑块提取完成.md`

---

## 快速开始

### 必读信息
1. **已提取的大逻辑块文件**: `prd/lua重构Phase3.5-大逻辑块提取完成.md`
2. **所有新文件位置**: `src/lua/includes/` 下的新目录
3. **替换策略**: 三个阶段，从简单到复杂

### 替换步骤流程
```
读取 PRD → 打开脚本 → 定位重复代码 → 添加 @include → 替换为函数调用 → 验证 → 提交
```

---

## Phase 3.5a: 第1批 - 核心流程块（优先级 1）

### 使用块1、2、3进行替换

#### 块1: update-group-ready-limited-state
**文件**: `src/lua/includes/group-lifecycle/update-group-ready-limited-state.lua`
**导入方式**: `@include "includes/group-lifecycle/update-group-ready-limited-state"`

**需要替换的位置** (16处):

| 脚本 | 位置数 | 优先级 |
|------|--------|--------|
| reserve.lua | 3 | 高 |
| reserve-batch.lua | 2 | 高 |
| complete-with-metadata.lua | 2 | 高 |
| change-delay.lua | 1 | 中 |
| retry.lua | 1 | 中 |
| dead-letter.lua | 1 | 中 |
| check-stalled.lua | 1 | 中 |
| 其他8个 | 5 | 低 |

**替换前代码示例**:
```lua
-- 这种模式在reserve.lua第233-242行出现：
if not isGroupAtCapacity(ns, chosenGid) then
  redis.call("ZADD", readyKey, nextScore, chosenGid)
else
  redis.call("ZADD", limitedKey, nextScore, chosenGid)
end
```

**替换后代码**:
```lua
-- 在文件头添加
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- 在代码中调用
updateGroupReadyLimitedState(ns, chosenGid, readyKey, limitedKey, nextScore)
```

---

#### 块2: cleanup-if-group-empty
**文件**: `src/lua/includes/group-lifecycle/cleanup-if-group-empty.lua`
**导入方式**: `@include "includes/group-lifecycle/cleanup-if-group-empty"`

**需要替换的位置** (7处):

| 脚本 | 原始行数 | 新代码行数 | 节省 |
|------|---------|---------|------|
| dead-letter.lua | 8 | 1 | 7 |
| complete-with-metadata.lua | 16 | 1 | 15 |
| complete.lua | 13 | 1 | 12 |
| remove.lua | 9 | 1 | 8 |
| cleanup.lua | 13 | 1 | 12 |
| clean-status.lua | 14 | 1 | 13 |
| record-job-result.lua | 部分 | 1 | 大量 |

**替换前代码示例** (complete.lua):
```lua
local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

if remainingJobs <= 0 then
  redis.call("DEL", gZ)
  redis.call("DEL", groupMetaKey)
  redis.call("SREM", ns .. ":groups", gid)
  redis.call("ZREM", ns .. ":ready", gid)
  redis.call("DEL", ns .. ":buffer:" .. gid)
  redis.call("ZREM", ns .. ":buffering", gid)
else
  -- handle remaining jobs
end
```

**替换后代码**:
```lua
--- @include "includes/group-lifecycle/cleanup-if-group-empty"

local cleanupResult = cleanupIfGroupEmpty(ns, gid, -1)
if cleanupResult == "empty" then
  -- group已清理
else
  -- group仍有任务
end
```

---

#### 块3: cleanup-processing-job
**文件**: `src/lua/includes/group-lifecycle/cleanup-processing-job.lua`
**导入方式**: `@include "includes/group-lifecycle/cleanup-processing-job"`

**需要替换的位置** (6处):

| 脚本 | 原始行数 |
|------|---------|
| dead-letter.lua | 12 |
| retry.lua | 6 |
| complete-with-metadata.lua | 18 |
| check-stalled.lua | 18 |
| cleanup.lua | 8 |
| remove.lua | 部分 |

**替换前代码示例**:
```lua
redis.call("DEL", procKey)
redis.call("ZREM", ns .. ":processing", jobId)

local groupActiveKey = ns .. ":g:" .. gid .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)
```

**替换后代码**:
```lua
--- @include "includes/group-lifecycle/cleanup-processing-job"

local cleanupResult = cleanupProcessingJob(ns, jobId, gid, token)
if cleanupResult == "token-mismatch" then
  return 0
end
```

---

## Phase 3.5b: 第2批 - 业务流程块（优先级 2）

### 使用块4、5、6进行替换

#### 块4: handle-flow-child-completion
**文件**: `src/lua/includes/flow-handling/handle-flow-child-completion.lua`

**替换脚本** (5处):
- complete-with-metadata.lua (Flow部分)
- record-job-result.lua (Flow部分)
- remove.lua (Flow部分)
- clean-status.lua (Flow部分)
- enqueue-flow.lua (部分)

**工作量**: 高 (需要理解Flow逻辑)

---

#### 块5: recover-stalled-jobs-complete
**文件**: `src/lua/includes/stalled-recovery/recover-stalled-jobs-complete.lua`

**替换脚本** (5处):
- reserve.lua (行39-96)
- reserve-batch.lua (类似)
- check-stalled.lua (完整脚本)
- cleanup.lua (部分)

**工作量**: 高 (复杂的状态转移逻辑)

---

#### 块6: promote-delayed-job-complete
**文件**: `src/lua/includes/delayed-handling/promote-delayed-job-complete.lua`

**替换脚本** (3处):
- promote-delayed-one.lua (整个脚本)
- promote-delayed-jobs.lua (核心逻辑)
- change-delay.lua (部分)

**工作量**: 中

---

## Phase 3.5c: 第3批 - 特殊块替换（优先级 3）

### 使用块7、8、9、10进行替换

#### 块7: handle-job-retry-with-backoff
**文件**: `src/lua/includes/retry-handling/handle-job-retry-with-backoff.lua`

**替换脚本**:
- retry.lua (整个脚本替换)

**工作量**: 中

---

#### 块8: record-job-finalization
**文件**: `src/lua/includes/job-lifecycle/record-job-finalization.lua`

**替换脚本** (2处):
- complete-with-metadata.lua (完成/失败记录部分)
- record-job-result.lua (部分)

**工作量**: 中

---

#### 块9: delete-job-completely
**文件**: `src/lua/includes/job-lifecycle/delete-job-completely.lua`

**替换脚本**:
- remove.lua (整个脚本)

**工作量**: 高 (复杂逻辑)

---

#### 块10: enqueue-job-with-idempotence
**文件**: `src/lua/includes/job-lifecycle/enqueue-job-with-idempotence.lua`

**替换脚本** (2处):
- enqueue.lua (幂等性检查部分)
- enqueue-batch.lua (幂等性检查部分)

**工作量**: 中

---

## 🔍 替换检查清单

替换每个脚本时，确保：

### 前置检查
- [ ] 打开原始脚本，找到对应的重复代码
- [ ] 在新的PRD文件中找到对应块的信息
- [ ] 理解块函数的输入/输出
- [ ] 确认所有依赖已包含

### 替换步骤
- [ ] 在脚本顶部添加 `--- @include` 语句
- [ ] 找到所有重复代码位置
- [ ] 用函数调用替换
- [ ] 检查变量名称是否匹配
- [ ] 检查返回值处理是否正确

### 后置验证
- [ ] 代码行数明显减少
- [ ] 逻辑流程保持不变
- [ ] 没有引入新的依赖
- [ ] Redis操作顺序不改变
- [ ] 错误处理路径保留

---

## 📝 替换模板

### 添加include
```lua
--- @include "includes/group-lifecycle/cleanup-if-group-empty"
```

### 函数调用示例
```lua
-- 替换前：多行重复代码
if remainingJobs <= 0 then
  redis.call("DEL", gZ)
  redis.call("DEL", groupMetaKey)
  -- ... 更多代码
end

-- 替换后：一行函数调用
local result = cleanupIfGroupEmpty(ns, groupId, -1)
```

---

## ⚠️ 常见陷阱

### 1. 忘记添加 @include
**错误**: 直接调用函数但没有include
**解决**: 在文件顶部添加 `--- @include` 语句

### 2. 参数顺序错误
**错误**: 传入参数的顺序与函数签名不符
**解决**: 参考块定义中的函数签名

### 3. 返回值处理
**错误**: 不检查函数返回值
**解决**: 根据块的定义处理所有返回值

### 4. 遗漏某些位置
**错误**: 只替换了部分重复代码
**解决**: 使用文本搜索确保替换所有位置

### 5. 改变逻辑顺序
**错误**: 调整Redis操作的顺序
**解决**: 保持完全相同的操作顺序

---

## 🧪 测试验证

### 每个脚本替换后
```bash
# 1. 检查语法
lua -l /path/to/loader.ts your_script.lua

# 2. 如果有单元测试
npm test -- your_script.spec.ts
```

### 替换完整阶段后
```bash
# 运行完整测试套件
npm test

# 验证代码行数减少
wc -l src/lua/**/*.lua | tail -1
```

---

## 📊 预期结果

### Phase 3.5a 完成后
- ✅ 29个脚本位置已替换
- ✅ ~250行代码已精简
- ✅ 所有142个测试通过
- ✅ 零回归

### 总体目标
| 阶段 | 脚本数 | 代码精简 | 状态 |
|------|--------|--------|------|
| 3.5a (块1-3) | 29 | ~250行 | 进行中 |
| 3.5b (块4-6) | 18 | ~680行 | 待做 |
| 3.5c (块7-10) | 8 | ~450行 | 待做 |
| 总计 | 55+ | ~1380行 | 规划中 |

---

## 💾 Git工作流

### 每个脚本替换后提交
```bash
git add src/lua/your_script.lua
git commit -m "refactor: replace repeated logic with [块名] in your_script.lua

- Removed X lines of duplicate code
- Added @include for [块名]
- Reduced from Y lines to Z lines
- Maintains 100% backward compatibility

🤖 Generated with Claude Code"
```

### 每个阶段完成后提交总结
```bash
git add -A
git commit -m "refactor: complete Phase 3.5a - replace core logic blocks

Summary:
- Replaced 29 script locations
- Reduced ~250 lines of code
- All 142 tests passing
- Zero regressions

🤖 Generated with Claude Code"
```

---

## 🎯 成功标准

✅ **Phase 3.5a 完成条件:**
- 所有第1批脚本已替换
- 代码行数从 ~3500 减至 ~3250
- 所有测试通过
- 零功能回归
- Git历史清晰

✅ **整个 Phase 3.5 完成条件:**
- 所有10个块已使用
- 代码行数从 ~3500 减至 ~2400
- 代码复用度达到 85%+
- 所有测试通过
- 文档更新完成

---

**下一步**: 打开新的AI窗口，参考此文件开始 Phase 3.5a 替换！
