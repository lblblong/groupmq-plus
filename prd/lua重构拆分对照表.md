# Lua 重构拆分对照表

## 🎯 一览表：从多函数文件到单函数文件

### Phase 1 → Phase 2 映射

#### 1️⃣ concurrency-control.lua → 5 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `getGroupConcurrencyLimit()` | `concurrency-control/get-group-concurrency-limit.lua` | - | 查询 |
| `getGroupActiveCount()` | `concurrency-control/get-group-active-count.lua` | - | 查询 |
| `isGroupAtCapacity()` | `concurrency-control/is-group-at-capacity.lua` | ↓ 下面两个 | 查询 |
| `getAvailableSlots()` | `concurrency-control/get-available-slots.lua` | ↓ 下面两个 | 查询 |
| `updateGroupState()` | `concurrency-control/update-group-state.lua` | ↓ 下面两个 | 修改 |

**组织特点**：query functions 独立，modifying function 依赖 query functions

---

#### 2️⃣ delayed-handling.lua → 6 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `moveJobToDelayed()` | `delayed-handling/move-job-to-delayed.lua` | - | 修改 |
| `promoteJobFromDelayed()` | `delayed-handling/promote-job-from-delayed.lua` | - | 修改 |
| `promoteReadyDelayedJobs()` | `delayed-handling/promote-ready-delayed-jobs.lua` | ↑ 上面一个 | 批量 |
| `changeJobDelay()` | `delayed-handling/change-job-delay.lua` | - | 修改 |
| `isJobDelayed()` | `delayed-handling/is-job-delayed.lua` | - | 查询 |
| `getJobDelayTime()` | `delayed-handling/get-job-delay-time.lua` | - | 查询 |

**组织特点**：基础操作独立，批量操作依赖基础操作

---

#### 3️⃣ group-status.lua → 9 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `getGroupJobCount()` | `group-status/get-group-job-count.lua` | - | 查询 |
| `isGroupEmpty()` | `group-status/is-group-empty.lua` | - | 查询 |
| `getGroupHeadJob()` | `group-status/get-group-head-job.lua` | - | 查询 |
| `getGroupHeadJobWithScore()` | `group-status/get-group-head-job-with-score.lua` | ↑ 上面一个 | 查询 |
| `getGroupActiveTaskCount()` | `group-status/get-group-active-task-count.lua` | - | 查询 |
| `isJobActive()` | `group-status/is-job-active.lua` | - | 查询 |
| `getGroupActiveJobs()` | `group-status/get-group-active-jobs.lua` | - | 查询 |
| `getGroupDelayedCount()` | `group-status/get-group-delayed-count.lua` | - | 查询 |
| `getGroupStatus()` | `group-status/get-group-status.lua` | ↓ 下面三个 | 聚合 |

**组织特点**：细粒度查询独立，聚合查询依赖细粒度查询

---

#### 4️⃣ ghost-cleanup.lua → 2 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `cleanupGhostTasks()` | `ghost-cleanup/cleanup-ghost-tasks.lua` | - | 修改 |
| `detectGhostTasks()` | `ghost-cleanup/detect-ghost-tasks.lua` | - | 查询 |

**组织特点**：两个独立函数，无相互依赖

---

#### 5️⃣ stalled-recovery.lua → 1 个文件（保持）

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `recoverStalledJobs()` | `stalled-recovery.lua` | - | 复杂操作 |

**组织特点**：单个复杂函数，逻辑紧密，暂不拆分

---

#### 6️⃣ token-verify.lua → 3 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `verifyToken()` | `token-verify/verify-token.lua` | - | 查询 |
| `getJobToken()` | `token-verify/get-job-token.lua` | - | 查询 |
| `hasActiveLock()` | `token-verify/has-active-lock.lua` | - | 查询 |

**组织特点**：三个独立查询函数

---

#### 7️⃣ job-data.lua → 5 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `getJobFullData()` | `job-data/get-job-full-data.lua` | - | 读取 |
| `parseJobData()` | `job-data/parse-job-data.lua` | ↑ 上面一个 | 转换 |
| `validateJobData()` | `job-data/validate-job-data.lua` | - | 验证 |
| `hasJobField()` | `job-data/has-job-field.lua` | - | 验证 |
| `formatJobDataString()` | `job-data/format-job-data-string.lua` | ↑ parse 函数 | 转换 |

**组织特点**：数据处理流水线（读→解析→验证→格式化）

---

#### 8️⃣ key-helpers.lua → 10 个文件

| Phase 1 | Phase 2 | 依赖 | 类型 |
|---------|---------|------|------|
| `makeGroupKey()` | `key-helpers/make-group-key.lua` | - | 构造 |
| `makeJobKey()` | `key-helpers/make-job-key.lua` | - | 构造 |
| `makeConfigKey()` | `key-helpers/make-config-key.lua` | - | 构造 |
| `makeProcessingKey()` | `key-helpers/make-processing-key.lua` | - | 构造 |
| `makeActiveListKey()` | `key-helpers/make-active-list-key.lua` | - | 构造 |
| `makeGroupLockKey()` | `key-helpers/make-group-lock-key.lua` | - | 构造 |
| `makeGroupMetaKey()` | `key-helpers/make-group-meta-key.lua` | - | 构造 |
| `makeUniqueKey()` | `key-helpers/make-unique-key.lua` | - | 构造 |
| `getJobKeys()` | `key-helpers/get-job-keys.lua` | ↓ 5个 make-* | 聚合 |
| `getGroupKeys()` | `key-helpers/get-group-keys.lua` | ↓ 5个 make-* | 聚合 |

**组织特点**：基础键构造独立，聚合键查询依赖基础构造

---

## 📊 统计数据

### 文件拆分统计

| 源文件 | 函数数 | 拆分后文件 | 占比 |
|--------|--------|-----------|------|
| concurrency-control.lua | 5 | 5 | 12% |
| delayed-handling.lua | 6 | 6 | 15% |
| group-status.lua | 9 | 9 | 22% |
| ghost-cleanup.lua | 2 | 2 | 5% |
| stalled-recovery.lua | 1 | 1 | 2% |
| token-verify.lua | 3 | 3 | 7% |
| job-data.lua | 5 | 5 | 12% |
| key-helpers.lua | 10 | 10 | 24% |
| **总计** | **41** | **41** | **100%** |

### 新目录层级

```
Phase 2 结构 (39 个新文件 + 1 个保留文件 = 40 个文件)

concurrency-control/       (5 files)
delayed-handling/          (6 files)
ghost-cleanup/             (2 files)
group-status/              (9 files)
job-data/                  (5 files)
key-helpers/              (10 files)
token-verify/              (3 files)
stalled-recovery.lua       (1 file, no subdir)
```

---

## 🔗 依赖关系图

### 内部依赖统计

| 模块 | 内部依赖 | 外部依赖 | 被依赖次数 |
|------|---------|---------|----------|
| concurrency-control | 3对 | 0 | 多次 |
| delayed-handling | 1对 | 0 | 多次 |
| group-status | 2对 | 0 | 少 |
| ghost-cleanup | 0对 | 0 | 多次 |
| stalled-recovery | 0对 | 0 | 多次 |
| token-verify | 0对 | 0 | 少 |
| job-data | 2对 | 0 | 多次 |
| key-helpers | 2对 | 0 | 多次 |

**说明**：
- 内部依赖 = 同模块内的 include 关系
- 外部依赖 = 依赖其他模块（目前无）
- 被依赖次数 = 被其他脚本 include 的频率

---

## 📋 @include 使用示例

### 示例 1：简单依赖

```lua
-- concurrency-control/is-group-at-capacity.lua
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return activeCount >= limit
end
```

### 示例 2：链式依赖

```lua
-- group-status/get-group-status.lua
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

### 示例 3：脚本中的使用

```lua
-- reserve.lua (Phase 3 脚本重构)
--- @include "includes/stalled-recovery"
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/concurrency-control/update-group-state"
--- @include "includes/ghost-cleanup/cleanup-ghost-tasks"
--- @include "includes/job-data/get-job-full-data"
--- @include "includes/job-data/validate-job-data"

-- 现在脚本可以直接使用这些函数，
-- loader 会递归加载所有依赖并合并为单一脚本
```

---

## ✅ 迁移检查清单

### 创建文件阶段
- [ ] `concurrency-control/` - 5 个文件创建完成
- [ ] `delayed-handling/` - 6 个文件创建完成
- [ ] `ghost-cleanup/` - 2 个文件创建完成
- [ ] `group-status/` - 9 个文件创建完成
- [ ] `job-data/` - 5 个文件创建完成
- [ ] `key-helpers/` - 10 个文件创建完成
- [ ] `token-verify/` - 3 个文件创建完成
- [ ] `stalled-recovery.lua` - 保持不变

### @include 添加阶段
- [ ] 检查所有依赖关系，添加正确的 `@include` 指令
- [ ] 验证没有循环依赖
- [ ] 验证没有遗漏的依赖

### Loader 增强阶段
- [ ] 更新 `loader.ts` 支持子目录
- [ ] 实现递归 include 解析
- [ ] 实现循环依赖检测
- [ ] 编写单元测试

### 测试验证阶段
- [ ] 单个函数文件可独立加载
- [ ] 嵌套 include 正确递归解析
- [ ] 脚本合并结果正确
- [ ] SHA 哈希计算正确
- [ ] 脚本执行功能无回归

---

## 🎯 优先级建议

### 第一优先级（高收益）
1. `group-status/` - 最复杂的拆分（9→9），最常被使用
2. `concurrency-control/` - 高频使用，核心功能
3. `key-helpers/` - 基础设施，影响面广

### 第二优先级（中收益）
4. `delayed-handling/` - 中等复杂度
5. `job-data/` - 转换功能独立性好

### 第三优先级（低收益，完成度）
6. `token-verify/` - 简单，快速完成
7. `ghost-cleanup/` - 简单，快速完成

---

**最后更新**：2025-01-09
**总文件变化**：8 → 40（+32 个文件）
**总函数数量**：41（无变化，仅重组织）
