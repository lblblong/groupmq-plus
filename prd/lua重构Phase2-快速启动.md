# Lua 重构 Phase 2 - 快速启动指南

## 🚀 30 秒概览

**任务**：将 Phase 1 的 8 个多函数文件拆分为 39+ 个单函数文件

**核心改变**：
- 从 `includes/concurrency-control.lua` (5个函数)
- 拆分为 `includes/concurrency-control/is-group-at-capacity.lua` 等

**关键点**：
- ✅ 每个文件 = 一个函数
- ✅ 函数间依赖用 `@include` 引用
- ✅ Loader 自动递归加载依赖

---

## 📝 立即可用的模板

### 模板 1：无依赖的单函数文件

**文件**：`includes/concurrency-control/get-group-concurrency-limit.lua`

```lua
--[[
  Get the concurrency limit for a group

  Returns the configured concurrency limit or defaults to 1.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Concurrency limit (number)
]]
local function getGroupConcurrencyLimit(ns, groupId)
  local configKey = ns .. ":config:" .. groupId
  return tonumber(redis.call("HGET", configKey, "concurrency")) or 1
end
```

**注意**：
- 函数定义使用 `local function`（会被 Lua 作用域保护）
- 在主脚本中 include 时，它会被加载到脚本的全局作用域
- 清晰的文档注释说明参数和返回值

---

### 模板 2：有依赖的单函数文件

**文件**：`includes/concurrency-control/is-group-at-capacity.lua`

```lua
--[[
  Check if a group has reached its concurrency capacity

  This function depends on:
  - getGroupConcurrencyLimit()
  - getGroupActiveCount()

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: true if at/over capacity, false otherwise (boolean)
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return activeCount >= limit
end
```

**关键点**：
- `@include` 指令必须放在**函数定义之前**
- 相对路径从项目根 `src/lua/` 开始
- 不需要 `.lua` 扩展名

---

### 模板 3：聚合函数（多个依赖）

**文件**：`includes/group-status/get-group-status.lua`

```lua
--[[
  Get comprehensive status snapshot for a group

  Aggregates multiple status queries into a single result object.

  Dependencies:
  - getGroupJobCount()
  - getGroupActiveTaskCount()
  - getGroupHeadJob()

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Table with keys: jobCount, activeCount, headJob
]]
--- @include "includes/group-status/get-group-job-count"
--- @include "includes/group-status/get-group-active-task-count"
--- @include "includes/group-status/get-group-head-job"

local function getGroupStatus(ns, groupId)
  return {
    jobCount = getGroupJobCount(ns, groupId),
    activeCount = getGroupActiveTaskCount(ns, groupId),
    headJob = getGroupHeadJob(ns, groupId)
  }
end
```

---

## 🔧 逐步实施指南

### Step 1: 创建目录结构（5 分钟）

```bash
cd src/lua/includes

# 创建子目录
mkdir -p concurrency-control
mkdir -p delayed-handling
mkdir -p ghost-cleanup
mkdir -p group-status
mkdir -p job-data
mkdir -p key-helpers
mkdir -p token-verify

# 验证结构
ls -la
# 应该看到 8 个目录 + stalled-recovery.lua + 原始 8 个 .lua 文件
```

### Step 2: 拆分第一个文件 - `concurrency-control.lua`（15 分钟）

#### 2.1 读取原始文件

```bash
cat includes/concurrency-control.lua
```

你应该看到 5 个函数。

#### 2.2 创建 5 个新文件

**File 1**: `includes/concurrency-control/get-group-concurrency-limit.lua`
```lua
--[[
  Get the concurrency limit for a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Concurrency limit (default 1 if not configured)
]]
local function getGroupConcurrencyLimit(ns, groupId)
  local configKey = ns .. ":config:" .. groupId
  return tonumber(redis.call("HGET", configKey, "concurrency")) or 1
end
```

**File 2**: `includes/concurrency-control/get-group-active-count.lua`
```lua
--[[
  Get the current number of active tasks in a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of active tasks
]]
local function getGroupActiveCount(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LLEN", activeKey)
end
```

**File 3**: `includes/concurrency-control/is-group-at-capacity.lua`
```lua
--[[
  Check if a group has reached its concurrency capacity

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: true if at/over capacity, false otherwise
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return activeCount >= limit
end
```

**File 4**: `includes/concurrency-control/get-available-slots.lua`
```lua
--[[
  Get the number of available processing slots

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of available slots (0 if full)
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function getAvailableSlots(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return math.max(0, limit - activeCount)
end
```

**File 5**: `includes/concurrency-control/update-group-state.lua`
```lua
--[[
  Update group's ready/limited status based on capacity

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    readyKey: Redis key for the ready queue
    limitedKey: Redis key for the limited queue

  Returns: nothing (void)
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function updateGroupState(ns, groupId, readyKey, limitedKey)
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")

  if not head or #head < 2 then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
    return
  end

  local headScore = tonumber(head[2])
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)

  if activeCount >= limit then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZADD", limitedKey, headScore, groupId)
  else
    redis.call("ZREM", limitedKey, groupId)
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end
```

#### 2.3 验证文件创建

```bash
ls -la src/lua/includes/concurrency-control/
# 应该看到 5 个 .lua 文件
```

### Step 3: 测试新文件是否可加载

创建临时测试脚本 `test-includes.lua`：

```lua
--- @include "includes/concurrency-control/is-group-at-capacity"

-- 现在 isGroupAtCapacity 函数应该可用
local result = isGroupAtCapacity("mq", "group1")
return result
```

通过 TypeScript/Node.js 测试：

```typescript
import { loadScript } from './src/lua/loader';
import Redis from 'ioredis';

const client = new Redis();
const sha = await loadScript(client, 'test-includes');
console.log('SHA:', sha);
```

如果没有错误，说明 loader 已经支持新的 include 路径！

### Step 4: 修改主脚本以使用新 includes

以 `reserve.lua` 为例：

**Before**:
```lua
--- @include "includes/concurrency-control"
--- @include "includes/ghost-cleanup"

local capacity = isGroupAtCapacity(ns, gid)
```

**After**:
```lua
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/concurrency-control/get-group-active-count"
--- @include "includes/concurrency-control/update-group-state"
--- @include "includes/ghost-cleanup/cleanup-ghost-tasks"

local capacity = isGroupAtCapacity(ns, gid)
```

或者（更精细的控制）：
```lua
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/ghost-cleanup/cleanup-ghost-tasks"

-- 现在脚本只包含需要的函数，不加载不需要的
```

---

## 🎯 分阶段任务分配

### 第一周 - 文件拆分

| 天 | 任务 | 工作量 | 优先级 |
|----|------|--------|--------|
| 周一 | 创建目录 + 拆分 concurrency-control | 2h | 🔴 高 |
| 周二 | 拆分 group-status | 3h | 🔴 高 |
| 周三 | 拆分 delayed-handling | 2h | 🟡 中 |
| 周四 | 拆分其他（job-data, key-helpers） | 3h | 🟡 中 |
| 周五 | 拆分 token-verify, ghost-cleanup | 2h | 🟢 低 |

### 第二周 - Loader 增强

| 天 | 任务 | 工作量 | 优先级 |
|----|------|--------|--------|
| 周一 | 增强 loader.ts 支持子目录 | 3h | 🔴 高 |
| 周二 | 递归依赖解析 + 循环检测 | 3h | 🔴 高 |
| 周三 | 单元测试 | 2h | 🔴 高 |
| 周四 | 更新脚本 include 引用 | 4h | 🔴 高 |
| 周五 | 集成测试 + 文档 | 3h | 🟡 中 |

### 第三周 - 验证

| 天 | 任务 | 工作量 | 优先级 |
|----|------|--------|--------|
| 周一 | 全量功能测试 | 4h | 🔴 高 |
| 周二 | 性能基准测试 | 3h | 🟡 中 |
| 周三 | Bug 修复 | 3h | 🔴 高 |
| 周四 | 文档完善 | 2h | 🟢 低 |
| 周五 | 最终验收 | 2h | 🔴 高 |

---

## ⚠️ 常见陷阱和解决方案

### 陷阱 1：忘记添加 @include 指令

**症状**：
```
Error: undefined function getGroupConcurrencyLimit
```

**原因**：文件中使用的函数没有对应的 `@include`

**解决**：
```lua
--- @include "includes/concurrency-control/get-group-concurrency-limit"

local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)  -- 现在可以找到
  ...
end
```

---

### 陷阱 2：相对路径写错

**症状**：
```
Error: Script not found: includes/concurrency-control.lua
```

**原因**：路径不对（missing 'includes/' prefix or wrong case）

**解决**：
```lua
-- ❌ 错误
--- @include "concurrency-control/is-group-at-capacity"

-- ✅ 正确
--- @include "includes/concurrency-control/is-group-at-capacity"
```

---

### 陷阱 3：循环依赖

**症状**：
```
Error: Circular dependency detected: A → B → A
```

**原因**：A.lua include B.lua，B.lua 又 include A.lua

**解决**：重新审视模块设计，打破循环

```lua
-- ❌ 循环
-- A.lua includes B.lua
--- @include "includes/module/b"

-- B.lua includes A.lua
--- @include "includes/module/a"

-- ✅ 解决方案：提取共同依赖
-- common.lua (独立)
-- A.lua includes common.lua
-- B.lua includes common.lua
```

---

### 陷阱 4：函数定义位置

**症状**：
```
Lua syntax error near '...'
```

**原因**：在 include 之前定义了依赖函数

**解决**：
```lua
-- ❌ 错误
local function helper()
  return 42
end

--- @include "includes/other"  -- 太晚了

-- ✅ 正确
--- @include "includes/other"

local function helper()
  return 42
end
```

---

## 🧪 快速测试清单

### 单文件测试

```bash
# 测试单个 include 文件是否能加载
npm test -- src/lua/includes/concurrency-control/get-group-concurrency-limit.lua
```

### 嵌套依赖测试

```bash
# 测试有依赖的 include 文件
npm test -- src/lua/includes/concurrency-control/is-group-at-capacity.lua
# 应该自动加载 get-group-concurrency-limit 和 get-group-active-count
```

### 脚本集成测试

```bash
# 测试主脚本（如 reserve.lua）是否能加载所有依赖
npm test -- src/lua/reserve.lua
```

### 完整功能测试

```bash
# 运行 BDD 测试
npm test

# 运行性能基准测试
npm run bench
```

---

## 📚 文档导引

| 文档 | 用途 |
|------|------|
| [lua重构第二阶段-单函数模块化.md](./lua重构第二阶段-单函数模块化.md) | 详细的拆分计划和依赖图 |
| [lua重构拆分对照表.md](./lua重构拆分对照表.md) | Phase 1 → Phase 2 的映射对照表 |
| [lua重构实施步骤.md](./lua重构实施步骤.md) | Phase 1 的原始实施指南（参考） |
| [lua重构方案.md](./lua重构方案.md) | Phase 1 的原始方案文档（参考） |

---

## 💬 常见问题

### Q1: 为什么要拆分成单函数文件？

**A**:
1. **精确复用** - 脚本可以只 include 需要的函数，避免加载不必要的代码
2. **清晰职责** - 每个文件一个明确的职责，易于维护
3. **并行开发** - 团队可以在不同函数上并行工作
4. **版本控制** - Git diff 更清晰，更容易追踪改动

### Q2: Include 会对性能有影响吗？

**A**:
- **编译时**：多个 include 会增加合并时间（~50-100ms），但只需要一次
- **执行时**：无影响，因为最终还是单一的 Lua 脚本
- **缓存**：SHA 哈希缓存机制，后续加载无开销

### Q3: 旧的脚本（include 单个文件）还能工作吗？

**A**:
- **可以**，通过兼容性 wrapper 保持向后兼容
- Phase 1 的文件可以保留为 wrapper，递归 include 所有子函数

### Q4: Include 路径可以用相对路径（../）吗？

**A**:
- **建议不用**，保持一致的绝对路径 `includes/module/function`
- 如需支持，可在 loader 增强时实现

---

## 🚦 下一步行动

### 立即可做（今天）
- [ ] 阅读 [lua重构第二阶段-单函数模块化.md](./lua重构第二阶段-单函数模块化.md)
- [ ] 创建目录结构
- [ ] 拆分第一个文件（concurrency-control）

### 本周完成
- [ ] 所有文件拆分完成
- [ ] 测试新文件能独立加载

### 下周完成
- [ ] Loader 增强
- [ ] 脚本 include 更新
- [ ] 集成测试

---

**祝重构顺利！** 🎉
