# GroupMQ Plus - Lua 脚本重构实施步骤

## 🎯 项目概览

**目标:** 将 33 个 Lua 脚本从 2600 行代码重构为模块化架构，减少 ~472 行重复代码
**总时间:** 5 周
**关键指标:** 48% 的重复代码消除，30-40% 的维护成本降低

---

## 📅 Phase 1: 创建 Includes 文件库 (第 1-2 周)

### 任务 1.1: 创建 `includes/stalled-recovery.lua`

**描述:** 提取幽灵任务恢复逻辑，被 `reserve.lua` 和 `reserve-batch.lua` 使用

**来源代码:**
- `reserve.lua` 行 16-98
- `reserve-batch.lua` 行 19-97

**具体步骤:**

- [ ] 1.1.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/stalled-recovery.lua`
- [ ] 1.1.2 - 从 `reserve.lua` 中提取幽灵任务恢复逻辑 (行 16-98)
- [ ] 1.1.3 - 提取的代码应该包装在 `recoverStalledJobs(ns, now, vt)` 函数中
- [ ] 1.1.4 - 添加文档注释说明函数作用和参数
- [ ] 1.1.5 - 验证提取的代码不依赖外部变量 (仅使用传入的参数和 redis.call)
- [ ] 1.1.6 - 创建单元测试: 测试 `recoverStalledJobs()` 函数的正确性
- [ ] 1.1.7 - 提交代码审查

**完成标准:**
```
✓ 文件已创建且包含完整的 recoverStalledJobs 函数
✓ 代码可以独立加载，不报错
✓ 单元测试通过
```

---

### 任务 1.2: 创建 `includes/concurrency-control.lua`

**描述:** 提取并发控制和组状态管理逻辑，被 5+ 个脚本使用

**来源代码:**
- `reserve.lua` 行 159-254
- `reserve-atomic.lua` 行 22-152
- `reserve-batch.lua` 行 113-213
- `retry.lua` 行 83-101
- `dead-letter.lua` 行 64-76

**具体步骤:**

- [ ] 1.2.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/concurrency-control.lua`
- [ ] 1.2.2 - 实现函数 `getGroupConcurrencyLimit(ns, groupId)` - 获取并发限制
- [ ] 1.2.3 - 实现函数 `getGroupActiveCount(ns, groupId)` - 获取活跃任务数
- [ ] 1.2.4 - 实现函数 `isGroupAtCapacity(ns, groupId)` - 检查是否满额
- [ ] 1.2.5 - 实现函数 `updateGroupState(ns, groupId, readyKey, limitedKey)` - 更新 ready/limited 状态
- [ ] 1.2.6 - 从各脚本验证逻辑的一致性 (合并重复部分)
- [ ] 1.2.7 - 添加详细的文档注释
- [ ] 1.2.8 - 创建单元测试: 测试每个函数的正确性
- [ ] 1.2.9 - 提交代码审查

**完成标准:**
```
✓ 4 个函数都已实现
✓ 函数逻辑与各脚本的实现一致
✓ 单元测试全部通过
```

---

### 任务 1.3: 创建 `includes/ghost-cleanup.lua`

**描述:** 提取幽灵任务清理逻辑，被 3 个脚本使用

**来源代码:**
- `reserve.lua` 行 136-156
- `reserve-batch.lua` 行 118-139
- `reserve-atomic.lua` 行 27-48

**具体步骤:**

- [ ] 1.3.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/ghost-cleanup.lua`
- [ ] 1.3.2 - 实现函数 `cleanupGhostTasks(ns, groupId)` - 清理活跃列表中的幽灵任务
- [ ] 1.3.3 - 函数应该返回清理的任务数量
- [ ] 1.3.4 - 添加详细的文档注释说明幽灵任务的定义
- [ ] 1.3.5 - 创建单元测试: 验证清理逻辑
- [ ] 1.3.6 - 提交代码审查

**完成标准:**
```
✓ cleanupGhostTasks 函数已实现
✓ 返回值正确 (清理的任务数)
✓ 单元测试通过
```

---

### 任务 1.4: 创建 `includes/job-data.lua`

**描述:** 提取任务数据读取和验证逻辑，被 4 个脚本使用

**来源代码:**
- `reserve.lua` 行 172
- `reserve-atomic.lua` 行 103-104
- `reserve-batch.lua` 行 154-155
- `enqueue-flow.lua`

**具体步骤:**

- [ ] 1.4.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/job-data.lua`
- [ ] 1.4.2 - 实现函数 `getJobFullData(jobKey)` - 读取任务的 10 个字段
- [ ] 1.4.3 - 实现函数 `parseJobData(jobData)` - 将数组解析为表/对象
- [ ] 1.4.4 - 实现函数 `validateJobData(jobData)` - 验证任务数据是否有效
- [ ] 1.4.5 - 添加详细的文档注释
- [ ] 1.4.6 - 创建单元测试: 验证各个函数
- [ ] 1.4.7 - 提交代码审查

**完成标准:**
```
✓ 3 个函数都已实现
✓ parseJobData 返回的对象字段名清晰 (id, groupId, payload 等)
✓ validateJobData 能正确识别损坏的数据
✓ 单元测试通过
```

---

### 任务 1.5: 创建 `includes/token-verify.lua`

**描述:** 提取 Token 验证逻辑，被 2 个脚本使用

**来源代码:**
- `retry.lua` 行 11-22
- `dead-letter.lua` 行 12-23

**具体步骤:**

- [ ] 1.5.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/token-verify.lua`
- [ ] 1.5.2 - 实现函数 `verifyToken(ns, jobId, expectedToken)` - 验证 Token 是否匹配
- [ ] 1.5.3 - 函数应该返回 true (验证通过) 或 false (验证失败)
- [ ] 1.5.4 - 添加详细的文档注释说明各种 Token 状态
- [ ] 1.5.5 - 创建单元测试: 测试各种 Token 场景 (匹配/不匹配/缺失)
- [ ] 1.5.6 - 提交代码审查

**完成标准:**
```
✓ verifyToken 函数已实现
✓ 返回值逻辑与原脚本一致
✓ 单元测试覆盖所有场景
```

---

### 任务 1.6: 创建 `includes/delayed-handling.lua`

**描述:** 提取延迟任务处理逻辑，被 4+ 个脚本使用

**来源代码:**
- `retry.lua` 行 47-76
- `promote-delayed-one.lua`
- `promote-delayed-jobs.lua`
- `change-delay.lua`

**具体步骤:**

- [ ] 1.6.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/delayed-handling.lua`
- [ ] 1.6.2 - 实现函数 `moveJobToDelayed(ns, jobId, groupId, delayUntil)` - 将任务移到延迟集合
- [ ] 1.6.3 - 实现函数 `promoteJobFromDelayed(ns, jobId, delayedKey, gZ)` - 从延迟集合提升任务
- [ ] 1.6.4 - 分析各脚本的延迟处理逻辑并抽象通用部分
- [ ] 1.6.5 - 添加详细的文档注释
- [ ] 1.6.6 - 创建单元测试
- [ ] 1.6.7 - 提交代码审查

**完成标准:**
```
✓ 延迟处理函数已实现
✓ 能处理物理分离模型 (delayed set 与 group zset 分离)
✓ 单元测试通过
```

---

### 任务 1.7: 创建 `includes/group-status.lua`

**描述:** 提取组状态查询函数，提供便利的接口

**具体步骤:**

- [ ] 1.7.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/group-status.lua`
- [ ] 1.7.2 - 实现函数 `getGroupJobCount(ns, groupId)` - 获取组内任务总数
- [ ] 1.7.3 - 实现函数 `isGroupEmpty(ns, groupId)` - 检查组是否为空
- [ ] 1.7.4 - 实现函数 `getGroupHeadJob(ns, groupId)` - 获取组头部任务
- [ ] 1.7.5 - 添加文档注释
- [ ] 1.7.6 - 创建单元测试
- [ ] 1.7.7 - 提交代码审查

**完成标准:**
```
✓ 3 个函数都已实现
✓ 函数返回值准确
✓ 单元测试通过
```

---

### 任务 1.8: 创建 `includes/key-helpers.lua`

**描述:** 提取 Redis 键构造辅助函数 (可选，用于提高代码可读性)

**具体步骤:**

- [ ] 1.8.1 - 新建文件 `/Users/lbl/net/groupmq-plus/src/lua/includes/key-helpers.lua`
- [ ] 1.8.2 - 实现函数 `makeGroupKey(ns, groupId)` - 返回 `ns:g:groupId`
- [ ] 1.8.3 - 实现函数 `makeJobKey(ns, jobId)` - 返回 `ns:job:jobId`
- [ ] 1.8.4 - 实现函数 `makeConfigKey(ns, groupId)` - 返回 `ns:config:groupId`
- [ ] 1.8.5 - 实现函数 `makeProcessingKey(ns, jobId)` - 返回 `ns:processing:jobId`
- [ ] 1.8.6 - 实现函数 `makeActiveListKey(ns, groupId)` - 返回 `ns:g:groupId:active`
- [ ] 1.8.7 - 创建单元测试
- [ ] 1.8.8 - 提交代码审查

**完成标准:**
```
✓ 键构造函数都已实现
✓ 键格式与现有代码一致
✓ 单元测试通过
```

---

### 任务 1.9: 验证所有 Includes 文件

**具体步骤:**

- [ ] 1.9.1 - 检查所有 8 个 include 文件都已创建
- [ ] 1.9.2 - 验证每个文件可以独立加载 (没有外部依赖)
- [ ] 1.9.3 - 检查没有循环依赖 (includes 之间不相互引用)
- [ ] 1.9.4 - 运行所有单元测试，确保全部通过
- [ ] 1.9.5 - 代码审查：检查函数签名、文档、错误处理
- [ ] 1.9.6 - 创建 `includes/README.md` 文档，说明各个 include 文件的作用

**完成标准:**
```
✓ 所有 8 个 include 文件都已创建
✓ 每个文件可以独立加载
✓ 所有单元测试通过
✓ 文档完整
```

---

## 📅 Phase 2: 增强 Loader 实现 (第 2 周)

### 任务 2.1: 备份现有 loader.ts

**具体步骤:**

- [ ] 2.1.1 - 复制 `/Users/lbl/net/groupmq-plus/src/lua/loader.ts` 到 `loader.ts.backup`
- [ ] 2.1.2 - 在 Git 中标记备份版本的提交号

**完成标准:**
```
✓ 备份文件已创建
✓ 提交号已记录
```

---

### 任务 2.2: 实现 Include 解析功能

**具体步骤:**

- [ ] 2.2.1 - 打开 `/Users/lbl/net/groupmq-plus/src/lua/loader.ts`
- [ ] 2.2.2 - 定义常量 `INCLUDE_REGEX` 用于匹配 `@include` 指令
  ```typescript
  const INCLUDE_REGEX = /^[-]{2,3}[ \t]*@include[ \t]+(["'])(.+?)\1[; \t\n]*$/m;
  ```
- [ ] 2.2.3 - 实现函数 `parseIncludes(content: string): string[]` - 解析脚本中的 @include 指令
- [ ] 2.2.4 - 创建单元测试验证 `parseIncludes()` 函数
- [ ] 2.2.5 - 提交代码审查

**完成标准:**
```
✓ INCLUDE_REGEX 能正确匹配各种格式的 @include 指令
✓ parseIncludes() 返回正确的路径数组
✓ 单元测试通过
```

---

### 任务 2.3: 实现递归依赖加载

**具体步骤:**

- [ ] 2.3.1 - 定义接口 `ScriptMetadata` 表示脚本的元数据
  ```typescript
  interface ScriptMetadata {
    name: string;
    path: string;
    content: string;
    dependencies: ScriptMetadata[];
  }
  ```
- [ ] 2.3.2 - 实现函数 `loadScriptWithDependencies(scriptPath, visited)` - 递归加载脚本及其依赖
- [ ] 2.3.3 - 实现循环依赖检测：如果 visited 中已存在该路径则抛出错误
- [ ] 2.3.4 - 实现缓存机制：使用 `metadataCache` 避免重复加载
- [ ] 2.3.5 - 创建单元测试验证递归加载
- [ ] 2.3.6 - 创建单元测试验证循环依赖检测
- [ ] 2.3.7 - 提交代码审查

**完成标准:**
```
✓ 递归加载工作正常
✓ 循环依赖能被检测并报错
✓ 缓存机制正常工作
✓ 单元测试通过
```

---

### 任务 2.4: 实现脚本合并功能

**具体步骤:**

- [ ] 2.4.1 - 实现函数 `mergeScripts(metadata: ScriptMetadata): string` - 合并脚本
- [ ] 2.4.2 - 实现依赖拓扑排序：确保被依赖的脚本先被合并
- [ ] 2.4.3 - 实现 @include 指令替换：用实际脚本内容替换 @include 行
- [ ] 2.4.4 - 实现空行清理：删除多余的空行
- [ ] 2.4.5 - 创建单元测试验证脚本合并
- [ ] 2.4.6 - 提交代码审查

**完成标准:**
```
✓ 脚本能正确合并
✓ 依赖顺序正确 (被依赖的脚本先出现)
✓ @include 指令被正确替换
✓ 合并后的脚本可以执行
✓ 单元测试通过
```

---

### 任务 2.5: 更新导出函数

**具体步骤:**

- [ ] 2.5.1 - 更新 `evalScript()` 函数以支持新的加载机制
- [ ] 2.5.2 - 确保 API 签名不变 (完全向后兼容)
- [ ] 2.5.3 - 更新缓存机制：先检查缓存，再加载并合并脚本
- [ ] 2.5.4 - 创建单元测试验证 `evalScript()` 函数
- [ ] 2.5.5 - 提交代码审查

**完成标准:**
```
✓ evalScript() 能正确加载不带 @include 的脚本
✓ evalScript() 能正确加载带 @include 的脚本
✓ 缓存机制工作正常
✓ API 完全向后兼容
✓ 单元测试通过
```

---

### 任务 2.6: 集成测试

**具体步骤:**

- [ ] 2.6.1 - 选择一个简单脚本 (如 `get-active-count.lua`) 作为测试对象
- [ ] 2.6.2 - 修改该脚本添加 `@include` 指令
- [ ] 2.6.3 - 运行集成测试，验证脚本能正确加载和执行
- [ ] 2.6.4 - 检查 Redis 返回的 SHA 哈希
- [ ] 2.6.5 - 验证脚本执行结果正确
- [ ] 2.6.6 - 提交代码审查

**完成标准:**
```
✓ 增强版 loader.ts 能正确加载带 @include 的脚本
✓ 脚本合并结果正确
✓ Redis SHA 哈希正确
✓ 脚本执行结果符合预期
✓ 集成测试通过
```

---

### 任务 2.7: 文档更新

**具体步骤:**

- [ ] 2.7.1 - 添加注释说明 @include 指令的语法
- [ ] 2.7.2 - 添加示例说明如何在脚本中使用 @include
- [ ] 2.7.3 - 创建 `loader.ts` 的文档注释
- [ ] 2.7.4 - 更新 README.md 说明新的加载机制

**完成标准:**
```
✓ 代码注释清晰
✓ 文档完整
```

---

## 📅 Phase 3: 脚本重构 (第 3-4 周)

### 任务 3.1: 重构简单脚本 (第 1 批)

**脚本列表 (无重复代码，作为热身):**
- `get-active-count.lua`
- `get-waiting-count.lua`
- `get-delayed-count.lua`
- `get-active-jobs.lua`
- `get-waiting-jobs.lua`
- `get-delayed-jobs.lua`
- `is-empty.lua`

**每个脚本的步骤:**

- [ ] 3.1.1 - 分析脚本，确认是否真的无重复代码
- [ ] 3.1.2 - 创建特性分支 `feat/lua-refactor-batch1`
- [ ] 3.1.3 - 验证脚本当前功能正常
- [ ] 3.1.4 - 修改脚本不需要添加 @include (这批脚本无重复)
- [ ] 3.1.5 - 运行测试验证功能不变
- [ ] 3.1.6 - 提交 PR: 标记为 "[Lua Refactor Batch 1]"

**完成标准:**
```
✓ 所有 7 个脚本都已验证
✓ 功能测试通过
✓ PR 已合并到主分支
```

---

### 任务 3.2: 重构中等复杂度脚本 (第 2 批)

**脚本列表 (带 1-2 个 include):**

#### 3.2.1 - 重构 `retry.lua`

**重复代码来源:**
- Token 验证 (lines 11-22) → 使用 `token-verify.lua`
- 并发控制 (lines 83-101) → 使用 `concurrency-control.lua`

**具体步骤:**

- [ ] 3.2.1.1 - 创建特性分支 `feat/lua-refactor-retry`
- [ ] 3.2.1.2 - 备份原始脚本
- [ ] 3.2.1.3 - 添加 @include 指令
  ```lua
  --- @include "includes/token-verify"
  --- @include "includes/concurrency-control"
  ```
- [ ] 3.2.1.4 - 删除 Token 验证代码，调用 `verifyToken()` 函数
- [ ] 3.2.1.5 - 删除并发控制代码，调用 `updateGroupState()` 等函数
- [ ] 3.2.1.6 - 验证脚本行数从 105 行减少到 ~65 行
- [ ] 3.2.1.7 - 运行单元测试验证功能
- [ ] 3.2.1.8 - 运行集成测试
- [ ] 3.2.1.9 - 代码审查
- [ ] 3.2.1.10 - 提交 PR

---

#### 3.2.2 - 重构 `dead-letter.lua`

**重复代码来源:**
- Token 验证 (lines 12-23) → 使用 `token-verify.lua`
- 并发控制 (lines 64-76) → 使用 `concurrency-control.lua`

**具体步骤:**

- [ ] 3.2.2.1 - 创建特性分支 `feat/lua-refactor-dead-letter`
- [ ] 3.2.2.2 - 备份原始脚本
- [ ] 3.2.2.3 - 添加 @include 指令
- [ ] 3.2.2.4 - 删除重复代码，调用 include 的函数
- [ ] 3.2.2.5 - 验证脚本行数从 87 行减少到 ~40 行
- [ ] 3.2.2.6 - 运行测试
- [ ] 3.2.2.7 - 提交 PR

---

#### 3.2.3 - 重构 `change-delay.lua`

**重复代码来源:**
- 延迟处理 → 使用 `delayed-handling.lua`

**具体步骤:**

- [ ] 3.2.3.1 - 创建特性分支
- [ ] 3.2.3.2 - 分析脚本中的延迟处理逻辑
- [ ] 3.2.3.3 - 添加 @include 指令
- [ ] 3.2.3.4 - 重构脚本
- [ ] 3.2.3.5 - 测试
- [ ] 3.2.3.6 - 提交 PR

---

#### 3.2.4 - 重构 `check-stalled.lua`

**重复代码来源:**
- 幽灵任务恢复 → 使用 `stalled-recovery.lua`

**具体步骤:**

- [ ] 3.2.4.1 - 创建特性分支
- [ ] 3.2.4.2 - 添加 @include 指令
- [ ] 3.2.4.3 - 调用 `recoverStalledJobs()` 函数
- [ ] 3.2.4.4 - 测试
- [ ] 3.2.4.5 - 提交 PR

---

### 任务 3.3: 重构复杂脚本 (第 3 批)

**脚本列表 (带 3+ 个 include):**

#### 3.3.1 - 重构 `reserve.lua` (最复杂)

**重复代码来源:**
- 幽灵任务恢复 (lines 16-98) → `stalled-recovery.lua`
- 并发控制 (lines 159-254) → `concurrency-control.lua`
- 幽灵任务清理 (lines 136-156) → `ghost-cleanup.lua`
- 任务数据读取 (line 172) → `job-data.lua`

**具体步骤:**

- [ ] 3.3.1.1 - 创建特性分支 `feat/lua-refactor-reserve`
- [ ] 3.3.1.2 - 备份原始脚本 (行数记录: 260 行)
- [ ] 3.3.1.3 - 添加 4 个 @include 指令
- [ ] 3.3.1.4 - 删除幽灵任务恢复代码，调用 `recoverStalledJobs()`
- [ ] 3.3.1.5 - 删除并发控制代码，调用 `updateGroupState()` 等
- [ ] 3.3.1.6 - 删除幽灵任务清理代码，调用 `cleanupGhostTasks()`
- [ ] 3.3.1.7 - 删除任务读取代码，调用 `getJobFullData()` 等
- [ ] 3.3.1.8 - 重构后的脚本应该 ~65 行 (压缩 75%)
- [ ] 3.3.1.9 - 运行单元测试
- [ ] 3.3.1.10 - 运行集成测试，验证预留功能
- [ ] 3.3.1.11 - 性能测试：确保没有性能下降
- [ ] 3.3.1.12 - 代码审查
- [ ] 3.3.1.13 - 提交 PR

---

#### 3.3.2 - 重构 `reserve-atomic.lua`

**重复代码来源:**
- 并发控制 (lines 22-152) → `concurrency-control.lua`
- 幽灵任务清理 (lines 27-48) → `ghost-cleanup.lua`
- 任务数据读取 (line 103-104) → `job-data.lua`

**具体步骤:**

- [ ] 3.3.2.1 - 创建特性分支 `feat/lua-refactor-reserve-atomic`
- [ ] 3.3.2.2 - 记录原始行数: 155 行
- [ ] 3.3.2.3 - 添加 3 个 @include 指令
- [ ] 3.3.2.4 - 删除重复代码，调用 include 的函数
- [ ] 3.3.2.5 - 重构后应该 ~50 行 (压缩 67%)
- [ ] 3.3.2.6 - 测试
- [ ] 3.3.2.7 - 提交 PR

---

#### 3.3.3 - 重构 `reserve-batch.lua`

**重复代码来源:**
- 幽灵任务恢复 (lines 19-97) → `stalled-recovery.lua`
- 并发控制 (lines 113-213) → `concurrency-control.lua`
- 幽灵任务清理 (lines 118-139) → `ghost-cleanup.lua`
- 任务数据读取 (line 154-155) → `job-data.lua`

**具体步骤:**

- [ ] 3.3.3.1 - 创建特性分支 `feat/lua-refactor-reserve-batch`
- [ ] 3.3.3.2 - 记录原始行数: 225 行
- [ ] 3.3.3.3 - 添加 4 个 @include 指令
- [ ] 3.3.3.4 - 删除重复代码
- [ ] 3.3.3.5 - 重构后应该 ~70 行 (压缩 69%)
- [ ] 3.3.3.6 - 测试
- [ ] 3.3.3.7 - 提交 PR

---

#### 3.3.4 - 重构其他脚本

**其他需要重构的脚本:**

- [ ] 3.3.4.1 - `complete.lua` - 分析并添加 @include
- [ ] 3.3.4.2 - `complete-with-metadata.lua` - 分析并添加 @include
- [ ] 3.3.4.3 - `complete-and-reserve-next-with-metadata.lua` - 分析并添加 @include
- [ ] 3.3.4.4 - `promote-delayed-one.lua` - 分析并添加 @include
- [ ] 3.3.4.5 - `promote-delayed-jobs.lua` - 分析并添加 @include
- [ ] 3.3.4.6 - `promote-staged.lua` - 分析并添加 @include
- [ ] 3.3.4.7 - `record-job-result.lua` - 分析并添加 @include
- [ ] 3.3.4.8 - `cleanup.lua` - 分析并添加 @include
- [ ] 3.3.4.9 - `clean-status.lua` - 分析并添加 @include
- [ ] 3.3.4.10 - `validate-limited-set.lua` - 分析并添加 @include
- [ ] 3.3.4.11 - `enqueue.lua` - 分析并添加 @include (已有)
- [ ] 3.3.4.12 - `enqueue-batch.lua` - 分析并添加 @include (已有)
- [ ] 3.3.4.13 - `enqueue-flow.lua` - 分析并添加 @include (已有)
- [ ] 3.3.4.14 - `remove.lua` - 分析并添加 @include
- [ ] 3.3.4.15 - `cleanup-poisoned-group.lua` - 分析并添加 @include
- [ ] 3.3.4.16 - `heartbeat.lua` - 分析并添加 @include

**对于每个脚本:**
- 创建特性分支
- 备份原始版本
- 添加 @include 指令
- 删除重复代码
- 运行测试
- 提交 PR

**完成标准:**
```
✓ 所有 33 个脚本都已重构
✓ 每个脚本都通过了功能测试
✓ 没有性能回归
✓ 代码行数总体减少 ~18%
```

---

## 📅 Phase 4: 验证和优化 (第 5 周)

### 任务 4.1: 全量功能测试

**具体步骤:**

- [ ] 4.1.1 - 运行完整的单元测试套件
  ```bash
  npm test -- src/lua
  ```
- [ ] 4.1.2 - 运行完整的集成测试套件
  ```bash
  npm test -- integration
  ```
- [ ] 4.1.3 - 验证所有 33 个脚本都能正确加载
- [ ] 4.1.4 - 验证脚本执行结果与重构前相同
- [ ] 4.1.5 - 验证没有遗漏任何脚本
- [ ] 4.1.6 - 检查错误日志，确保没有警告

**完成标准:**
```
✓ 所有单元测试通过
✓ 所有集成测试通过
✓ 所有 33 个脚本都能正确加载
✓ 脚本执行结果正确
✓ 没有警告或错误
```

---

### 任务 4.2: 性能基准测试

**具体步骤:**

- [ ] 4.2.1 - 创建性能测试脚本，测试主要操作的延迟
  - 入队 (enqueue)
  - 预留 (reserve)
  - 完成 (complete)
  - 重试 (retry)
- [ ] 4.2.2 - 在重构前版本上运行基准测试，记录结果
- [ ] 4.2.3 - 在重构后版本上运行相同的基准测试
- [ ] 4.2.4 - 对比两个版本的性能
  - 首次加载时间 (包括脚本合并)
  - 后续操作时间 (使用缓存)
- [ ] 4.2.5 - 验证没有性能下降 (允许 ±5% 的浮动)
- [ ] 4.2.6 - 生成性能报告

**完成标准:**
```
✓ 性能基准测试已完成
✓ 性能数据已记录
✓ 没有性能回归 (或可以接受)
✓ 首次加载时间合理 (<500ms)
✓ 后续操作时间无变化
```

---

### 任务 4.3: 代码审查和质量检查

**具体步骤:**

- [ ] 4.3.1 - 审查所有 8 个 include 文件
  - 代码质量
  - 文档完整性
  - 错误处理
  - 性能
- [ ] 4.3.2 - 审查增强版 `loader.ts`
  - 循环依赖检测
  - 脚本合并逻辑
  - 缓存机制
  - 错误处理
- [ ] 4.3.3 - 审查所有重构后的脚本
  - 确保逻辑正确
  - 确保 @include 指令正确
  - 确保没有遗漏任何代码
- [ ] 4.3.4 - 运行代码风格检查
  ```bash
  npm run lint
  ```
- [ ] 4.3.5 - 修复所有 lint 问题

**完成标准:**
```
✓ 所有代码都已审查
✓ 没有 lint 问题
✓ 文档完整
✓ 错误处理完善
```

---

### 任务 4.4: 文档完善

**具体步骤:**

- [ ] 4.4.1 - 创建 `/Users/lbl/net/groupmq-plus/docs/lua-refactoring.md` - 重构总结
  - 实施前后对比
  - 文件列表
  - 代码行数统计
  - 维护成本改进
- [ ] 4.4.2 - 更新 `includes/README.md`
  - 各个 include 文件的说明
  - 使用示例
- [ ] 4.4.3 - 更新主 README.md
  - 提及 Lua 脚本模块化
- [ ] 4.4.4 - 创建开发指南: 如何添加新的 include 文件
  - @include 指令语法
  - 最佳实践
  - 常见错误
- [ ] 4.4.5 - 更新 CHANGELOG.md

**完成标准:**
```
✓ 文档已创建
✓ 文档清晰完整
✓ 有使用示例
✓ 有开发指南
```

---

### 任务 4.5: 合并和发布准备

**具体步骤:**

- [ ] 4.5.1 - 合并所有特性分支到主分支
- [ ] 4.5.2 - 确保 CI/CD 通过
  ```bash
  npm run build
  npm test
  ```
- [ ] 4.5.3 - 生成 release notes
  - 重构内容总结
  - 新增的 include 文件
  - 优化结果
  - 兼容性说明 (完全向后兼容)
- [ ] 4.5.4 - 创建 Git tag
  ```bash
  git tag -a v2.0.0-lua-refactor -m "Lua script modularization refactor"
  ```
- [ ] 4.5.5 - 更新版本号 (如需要)

**完成标准:**
```
✓ 所有 PR 已合并
✓ CI/CD 通过
✓ Release notes 已生成
✓ Git tag 已创建
```

---

### 任务 4.6: 最后验证

**具体步骤:**

- [ ] 4.6.1 - 在开发环境再次运行完整测试
- [ ] 4.6.2 - 在测试环境部署并验证
- [ ] 4.6.3 - 验证所有关键功能
  - 创建队列
  - 入队任务
  - 预留任务
  - 完成任务
  - 重试任务
  - 清理任务
- [ ] 4.6.4 - 检查日志，确保没有错误
- [ ] 4.6.5 - 获得利益相关者的最终批准

**完成标准:**
```
✓ 所有测试通过
✓ 所有关键功能正常
✓ 没有错误或警告
✓ 已获得批准
```

---

## 📊 最终验收标准

### 代码质量指标
- [ ] 33 个 Lua 脚本都已重构
- [ ] 代码行数减少 ~472 行 (18% 压缩率)
- [ ] 8 个 include 文件都已创建并验证
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 没有 lint 问题

### 功能指标
- [ ] 完全向后兼容 (queue.ts 和 worker.ts 无需改动)
- [ ] 所有 33 个脚本都能正确加载
- [ ] 脚本执行结果与重构前相同
- [ ] 没有功能回归

### 性能指标
- [ ] 首次加载时间 <500ms
- [ ] 后续操作时间无变化
- [ ] 没有性能回归

### 文档指标
- [ ] Includes 文件都有清晰的文档
- [ ] 创建了开发指南
- [ ] 更新了主 README
- [ ] 生成了 release notes

### 时间指标
- [ ] Phase 1 (Includes): 2 周
- [ ] Phase 2 (Loader): 1 周
- [ ] Phase 3 (Refactor): 2 周
- [ ] Phase 4 (Verify): 1 周
- [ ] **总计: 6 周** (可能略有调整)

---

## 🎯 关键里程碑

| 里程碑 | 目标完成时间 | 状态 |
|-------|----------|-----|
| 所有 8 个 include 文件创建完成 | 第 2 周末 | ⬜ |
| Loader 增强完成 | 第 3 周末 | ⬜ |
| 简单脚本重构完成 (7 个) | 第 3 周末 | ⬜ |
| 中等脚本重构完成 (4 个) | 第 4 周初 | ⬜ |
| 复杂脚本重构完成 (22 个) | 第 4 周末 | ⬜ |
| 全量测试通过 | 第 5 周初 | ⬜ |
| 性能基准测试完成 | 第 5 周中 | ⬜ |
| 代码审查完成 | 第 5 周末 | ⬜ |
| **项目完成** | **第 5 周末** | ⬜ |

---

## 📝 注意事项

1. **备份策略**: 每次修改脚本前都要备份原始版本
2. **测试优先**: 修改前后都要运行测试
3. **逐个脚本**: 不要一次性修改所有脚本，容易引入 bug
4. **代码审查**: 每个 PR 都要代码审查
5. **向后兼容**: 确保所有改动对调用代码无影响
6. **文档优先**: 每个 include 文件都要有清晰的文档

---

## 💡 建议

- 按照 Phase 依次实施，不要跳过
- 如果某个任务遇到困难，先 PR 代码审查，获得帮助
- 定期运行全量测试，及时发现问题
- 保持提交历史清晰 (每个功能一个 commit)
- 遇到问题时，查看 `loader.ts.backup` 对比原实现

---

祝重构顺利! 🚀
