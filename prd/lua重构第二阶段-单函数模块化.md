# GroupMQ Plus - Lua 脚本重构第二阶段：单函数模块化

## 🎯 目标

将 Phase 1 的多函数文件进一步拆分为**每文件一函数**的设计，提升模块化程度和可维护性：

- ✅ 每个 `.lua` 文件包含且仅包含 **一个函数**
- ✅ Function 间的依赖通过 `@include` 指令引用
- ✅ `loader.ts` 支持**嵌套 @include** 的递归解析和合并
- ✅ 完全向后兼容（对外 API 不变）

---

## 📊 现状分析

### Phase 1 的文件结构（多函数）

| 文件 | 函数数量 | 代码行 | 状态 |
|------|---------|------|------|
| concurrency-control.lua | 5 | 114 | ⚠️ 待拆分 |
| delayed-handling.lua | 6 | 197 | ⚠️ 待拆分 |
| group-status.lua | 9 | 197 | ⚠️ 待拆分 |
| ghost-cleanup.lua | 2 | 83 | ✅ 可拆分 |
| stalled-recovery.lua | 1 | 110 | ✅ 保留 |
| token-verify.lua | 3 | 90 | ⚠️ 可拆分 |
| job-data.lua | 5 | 130 | ⚠️ 可拆分 |
| key-helpers.lua | 10 | 185 | ⚠️ 可拆分 |
| **总计** | **41** | **1,106** | - |

---

## 🔄 拆分计划

### Phase 2a: 拆分高优先级文件（第 1 周）

#### 1️⃣ **group-status.lua** → 4 个文件

**原始函数（9个）**：
- `getGroupJobCount()` - 查询等待任务数
- `isGroupEmpty()` - 检查组是否为空
- `getGroupHeadJob()` - 获取头部任务
- `getGroupHeadJobWithScore()` - 获取头部任务及优先级
- `getGroupActiveTaskCount()` - 查询活跃任务数
- `isJobActive()` - 检查任务是否活跃
- `getGroupActiveJobs()` - 获取所有活跃任务
- `getGroupDelayedCount()` - 查询延迟任务数
- `getGroupStatus()` - 获取组综合状态

**目标结构**：
```
includes/
├── group-status/
│   ├── get-group-job-count.lua              (reads: ZCARD)
│   ├── is-group-empty.lua                   (reads: ZCARD)
│   ├── get-group-head-job.lua               (reads: ZRANGE)
│   ├── get-group-head-job-with-score.lua    (reads: ZRANGE, depends: get-group-head-job)
│   ├── get-group-active-task-count.lua      (reads: LLEN)
│   ├── is-job-active.lua                    (reads: LPOS)
│   ├── get-group-active-jobs.lua            (reads: LRANGE)
│   ├── get-group-delayed-count.lua          (reads: ZCARD)
│   └── get-group-status.lua                 (aggregator, depends: get-group-job-count, get-group-active-task-count, get-group-head-job)
```

**依赖图**：
```
get-group-status.lua
├── @include "includes/group-status/get-group-job-count"
├── @include "includes/group-status/get-group-active-task-count"
└── @include "includes/group-status/get-group-head-job"

get-group-head-job-with-score.lua
└── @include "includes/group-status/get-group-head-job"
```

---

#### 2️⃣ **delayed-handling.lua** → 3 个文件

**原始函数（6个）**：
- `moveJobToDelayed()` - 将任务移入延迟集合
- `promoteJobFromDelayed()` - 将任务从延迟集合提升
- `promoteReadyDelayedJobs()` - 批量提升准备好的延迟任务
- `changeJobDelay()` - 修改任务延迟时间
- `isJobDelayed()` - 检查任务是否延迟
- `getJobDelayTime()` - 获取任务延迟时间

**目标结构**：
```
includes/
├── delayed-handling/
│   ├── move-job-to-delayed.lua              (writes: ZADD, HSET)
│   ├── promote-job-from-delayed.lua         (writes: ZREM, ZADD, HSET, HDEL)
│   ├── promote-ready-delayed-jobs.lua       (bulk op, depends: promote-job-from-delayed)
│   ├── change-job-delay.lua                 (writes: ZADD, HSET)
│   ├── is-job-delayed.lua                   (reads: ZSCORE)
│   └── get-job-delay-time.lua               (reads: ZSCORE)
```

**依赖图**：
```
promote-ready-delayed-jobs.lua
└── @include "includes/delayed-handling/promote-job-from-delayed"
```

---

#### 3️⃣ **concurrency-control.lua** → 2 个文件

**原始函数（5个）**：
- `getGroupConcurrencyLimit()` - 查询并发限制
- `getGroupActiveCount()` - 查询活跃任务数
- `isGroupAtCapacity()` - 检查是否满额
- `updateGroupState()` - 更新 ready/limited 状态
- `getAvailableSlots()` - 获取可用插槽数

**目标结构**：
```
includes/
├── concurrency-control/
│   ├── get-group-concurrency-limit.lua      (reads: HGET)
│   ├── get-group-active-count.lua           (reads: LLEN)
│   ├── is-group-at-capacity.lua             (depends: get-group-concurrency-limit, get-group-active-count)
│   ├── get-available-slots.lua              (depends: get-group-concurrency-limit, get-group-active-count)
│   └── update-group-state.lua               (writes: ZREM, ZADD, depends: get-group-concurrency-limit, get-group-active-count)
```

**依赖图**：
```
is-group-at-capacity.lua
├── @include "includes/concurrency-control/get-group-concurrency-limit"
└── @include "includes/concurrency-control/get-group-active-count"

get-available-slots.lua
├── @include "includes/concurrency-control/get-group-concurrency-limit"
└── @include "includes/concurrency-control/get-group-active-count"

update-group-state.lua
├── @include "includes/concurrency-control/get-group-concurrency-limit"
└── @include "includes/concurrency-control/get-group-active-count"
```

---

### Phase 2b: 拆分其他文件（第 1-2 周）

#### 4️⃣ **ghost-cleanup.lua** → 2 个文件

**原始函数（2个）**：
- `cleanupGhostTasks()` - 清理幽灵任务
- `detectGhostTasks()` - 检测幽灵任务

**目标结构**：
```
includes/
├── ghost-cleanup/
│   ├── cleanup-ghost-tasks.lua              (writes: LREM, reads: LRANGE, ZSCORE)
│   └── detect-ghost-tasks.lua               (reads: LRANGE, ZSCORE)
```

**无内部依赖**

---

#### 5️⃣ **token-verify.lua** → 3 个文件

**原始函数（3个）**：
- `verifyToken()` - 验证 Token
- `getJobToken()` - 获取 Token
- `hasActiveLock()` - 检查活跃锁

**目标结构**：
```
includes/
├── token-verify/
│   ├── verify-token.lua                     (reads: HGET)
│   ├── get-job-token.lua                    (reads: HGET)
│   └── has-active-lock.lua                  (reads: HGET)
```

**无内部依赖**

---

#### 6️⃣ **job-data.lua** → 5 个文件

**原始函数（5个）**：
- `getJobFullData()` - 读取完整任务数据
- `parseJobData()` - 解析任务数据
- `validateJobData()` - 验证任务数据
- `hasJobField()` - 检查任务字段
- `formatJobDataString()` - 格式化为字符串

**目标结构**：
```
includes/
├── job-data/
│   ├── get-job-full-data.lua                (reads: HMGET)
│   ├── parse-job-data.lua                   (pure transform, depends: get-job-full-data)
│   ├── validate-job-data.lua                (pure validation)
│   ├── has-job-field.lua                    (pure validation)
│   └── format-job-data-string.lua           (pure transform, depends: parse-job-data)
```

**依赖图**：
```
parse-job-data.lua
└── @include "includes/job-data/get-job-full-data"

format-job-data-string.lua
└── @include "includes/job-data/parse-job-data"
```

---

#### 7️⃣ **key-helpers.lua** → 10 个文件

**原始函数（10个）**：
- `makeGroupKey()` - 组键
- `makeJobKey()` - 任务键
- `makeConfigKey()` - 配置键
- `makeProcessingKey()` - 处理键
- `makeActiveListKey()` - 活跃列表键
- `makeGroupLockKey()` - 组锁键
- `makeGroupMetaKey()` - 组元数据键
- `makeUniqueKey()` - 唯一性键
- `getJobKeys()` - 获取任务所有键
- `getGroupKeys()` - 获取组所有键

**目标结构**：
```
includes/
├── key-helpers/
│   ├── make-group-key.lua                   (pure)
│   ├── make-job-key.lua                     (pure)
│   ├── make-config-key.lua                  (pure)
│   ├── make-processing-key.lua              (pure)
│   ├── make-active-list-key.lua             (pure)
│   ├── make-group-lock-key.lua              (pure)
│   ├── make-group-meta-key.lua              (pure)
│   ├── make-unique-key.lua                  (pure)
│   ├── get-job-keys.lua                     (depends: multiple make-* functions)
│   └── get-group-keys.lua                   (depends: multiple make-* functions)
```

**依赖图**：
```
get-job-keys.lua
├── @include "includes/key-helpers/make-job-key"
├── @include "includes/key-helpers/make-processing-key"
├── @include "includes/key-helpers/make-unique-key"
├── @include "includes/key-helpers/make-group-key"
└── @include "includes/key-helpers/make-active-list-key"

get-group-keys.lua
├── @include "includes/key-helpers/make-group-key"
├── @include "includes/key-helpers/make-config-key"
├── @include "includes/key-helpers/make-active-list-key"
├── @include "includes/key-helpers/make-group-lock-key"
└── @include "includes/key-helpers/make-group-meta-key"
```

---

#### 8️⃣ **stalled-recovery.lua** → 保留 1 个文件

**原因**：
- 只有 1 个复杂函数 `recoverStalledJobs()`
- 内部逻辑紧密，难以进一步拆分而不失去完整性
- 可以考虑提取内部 helper，但暂时保持现状

---

## 📝 总拆分结果

### 文件数量变化

| 阶段 | 文件数 | 函数数 | 备注 |
|------|-------|--------|------|
| Phase 1 | 8 | 41 | 多函数文件 |
| Phase 2 | **39** | 41 | 单函数文件（+stalled-recovery） |

### 新的目录结构

```
src/lua/includes/
├── concurrency-control/                 # 并发控制（5个文件）
│   ├── get-group-concurrency-limit.lua
│   ├── get-group-active-count.lua
│   ├── is-group-at-capacity.lua
│   ├── get-available-slots.lua
│   └── update-group-state.lua
│
├── delayed-handling/                    # 延迟处理（6个文件）
│   ├── move-job-to-delayed.lua
│   ├── promote-job-from-delayed.lua
│   ├── promote-ready-delayed-jobs.lua
│   ├── change-job-delay.lua
│   ├── is-job-delayed.lua
│   └── get-job-delay-time.lua
│
├── ghost-cleanup/                       # 幽灵任务清理（2个文件）
│   ├── cleanup-ghost-tasks.lua
│   └── detect-ghost-tasks.lua
│
├── group-status/                        # 组状态查询（9个文件）
│   ├── get-group-job-count.lua
│   ├── is-group-empty.lua
│   ├── get-group-head-job.lua
│   ├── get-group-head-job-with-score.lua
│   ├── get-group-active-task-count.lua
│   ├── is-job-active.lua
│   ├── get-group-active-jobs.lua
│   ├── get-group-delayed-count.lua
│   └── get-group-status.lua
│
├── job-data/                            # 任务数据处理（5个文件）
│   ├── get-job-full-data.lua
│   ├── parse-job-data.lua
│   ├── validate-job-data.lua
│   ├── has-job-field.lua
│   └── format-job-data-string.lua
│
├── key-helpers/                         # 键构造（10个文件）
│   ├── make-group-key.lua
│   ├── make-job-key.lua
│   ├── make-config-key.lua
│   ├── make-processing-key.lua
│   ├── make-active-list-key.lua
│   ├── make-group-lock-key.lua
│   ├── make-group-meta-key.lua
│   ├── make-unique-key.lua
│   ├── get-job-keys.lua
│   └── get-group-keys.lua
│
├── token-verify/                        # Token 验证（3个文件）
│   ├── verify-token.lua
│   ├── get-job-token.lua
│   └── has-active-lock.lua
│
├── stalled-recovery.lua                 # 幽灵任务恢复（保持单文件）
│
└── README.md                            # 新的文档
```

---

## 🔧 Loader 增强需求

### 当前 loader.ts 的问题

```lua
-- 现在可以写：
--- @include "includes/concurrency-control"

-- 但我们需要支持：
--- @include "includes/concurrency-control/is-group-at-capacity"
```

### 需要的改进

1. **支持子目录路径** - 解析 `includes/group-status/get-group-job-count`
2. **递归依赖解析** - 处理嵌套的 `@include`
3. **循环依赖检测** - 防止 A→B→A 的循环
4. **拓扑排序** - 确保依赖在被依赖者之前

### 更新的 loader.ts 示例

```typescript
// 现在可以处理：
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-status/get-group-status"

// 自动递归加载子依赖：
// is-group-at-capacity.lua
//   ├── @include "includes/concurrency-control/get-group-concurrency-limit"
//   └── @include "includes/concurrency-control/get-group-active-count"
```

---

## ✅ 实施步骤

### 第 1 周：创建新文件结构

- [ ] **任务 1.1** - 创建子目录结构
  ```bash
  mkdir -p src/lua/includes/{concurrency-control,delayed-handling,ghost-cleanup,group-status,job-data,key-helpers,token-verify}
  ```

- [ ] **任务 1.2** - 拆分 `group-status.lua` → 9 个文件
  - [ ] 1.2.1 - `includes/group-status/get-group-job-count.lua`
  - [ ] 1.2.2 - `includes/group-status/is-group-empty.lua`
  - [ ] 1.2.3 - `includes/group-status/get-group-head-job.lua`
  - [ ] 1.2.4 - `includes/group-status/get-group-head-job-with-score.lua` (with `@include`)
  - [ ] 1.2.5 - `includes/group-status/get-group-active-task-count.lua`
  - [ ] 1.2.6 - `includes/group-status/is-job-active.lua`
  - [ ] 1.2.7 - `includes/group-status/get-group-active-jobs.lua`
  - [ ] 1.2.8 - `includes/group-status/get-group-delayed-count.lua`
  - [ ] 1.2.9 - `includes/group-status/get-group-status.lua` (aggregator with `@include`)

- [ ] **任务 1.3** - 拆分 `delayed-handling.lua` → 6 个文件
  - 类似步骤...

- [ ] **任务 1.4** - 拆分 `concurrency-control.lua` → 5 个文件
  - 类似步骤...

- [ ] **任务 1.5** - 拆分其他文件
  - Ghost cleanup (2 个)
  - Token verify (3 个)
  - Job data (5 个)
  - Key helpers (10 个)

### 第 2 周：更新 Loader 和脚本引用

- [ ] **任务 2.1** - 增强 `loader.ts`
  - [ ] 2.1.1 - 支持子目录路径解析
  - [ ] 2.1.2 - 递归依赖加载
  - [ ] 2.1.3 - 循环依赖检测
  - [ ] 2.1.4 - 单元测试

- [ ] **任务 2.2** - 更新 includes 的 @include 引用
  - 从 `@include "includes/concurrency-control"` 改为 `@include "includes/concurrency-control/is-group-at-capacity"`

- [ ] **任务 2.3** - 测试脚本加载
  - 选择一个简单脚本测试完整的嵌套加载流程
  - 验证 SHA 哈希正确

### 第 3 周：验证和文档

- [ ] **任务 3.1** - 全量功能测试
  - [ ] 3.1.1 - 所有脚本能正确加载
  - [ ] 3.1.2 - 功能无回归
  - [ ] 3.1.3 - 性能无下降

- [ ] **任务 3.2** - 文档更新
  - [ ] 3.2.1 - 更新 `includes/README.md`
  - [ ] 3.2.2 - 创建 @include 使用指南
  - [ ] 3.2.3 - 更新主 README

---

## 💡 使用示例

### 脚本如何使用新的单函数 includes

**Before (Phase 1)**：
```lua
--- @include "includes/concurrency-control"

local limit = getGroupConcurrencyLimit(ns, groupId)
local active = getGroupActiveCount(ns, groupId)
local capacity = isGroupAtCapacity(ns, groupId)
```

**After (Phase 2)**：
```lua
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local limit = getGroupConcurrencyLimit(ns, groupId)
local active = getGroupActiveCount(ns, groupId)
local capacity = isGroupAtCapacity(ns, groupId)
```

或者只需要一个函数：
```lua
--- @include "includes/concurrency-control/is-group-at-capacity"

local capacity = isGroupAtCapacity(ns, groupId)
```

### Loader 自动递归加载

```lua
--- @include "includes/group-status/get-group-status"
```

Loader 会自动加载：
```
get-group-status.lua
├── @include "includes/group-status/get-group-job-count"
├── @include "includes/group-status/get-group-active-task-count"
└── @include "includes/group-status/get-group-head-job"
```

---

## 🎯 收益

| 指标 | 改进 |
|------|------|
| 模块化程度 | 从 8 个多函数文件 → 39 个单函数文件 |
| 代码复用粒度 | 可以精确选择需要的函数，不加载不需要的 |
| 维护成本 | 每个文件职责单一，更容易理解和修改 |
| 依赖可视化 | @include 关系清晰可见 |
| 团队协作 | 多人可以在不同的子模块并行开发 |

---

## ⚠️ 风险和缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Include 路径错误 | 中 | 中 | 完整的单元测试，清晰的错误消息 |
| 循环依赖 | 低 | 高 | Loader 编译时检测 |
| 性能下降 | 极低 | 中 | 脚本合并到内存，缓存优化 |
| 迁移遗漏 | 中 | 中 | 逐步迁移，充分测试 |

---

## 📚 参考

- 当前 Phase 1 文档：`prd/lua重构方案.md`
- Loader 源码：`src/lua/loader.ts`
- 新的 includes 结构：`src/lua/includes/`

---

**预计总耗时：3 周**
