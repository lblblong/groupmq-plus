# PRD: Lua 脚本代码重构与模块化 (Refactoring Plan)

**项目背景**：这是一个基于 Redis Lua 脚本的高性能任务队列系统。目前代码已经进行了一定程度的模块化（`includes/` 目录），但仍存在重复代码模式。
**重构目标**：进一步提取通用逻辑，减少代码重复，提高可维护性。
**核心原则**：保持现有业务逻辑不变，仅进行结构优化（Refactoring without behavior change）。

---

## 任务 1：提取响应格式化逻辑 (Job Response Formatting)

**优先级**：High
**背景**：多个脚本在返回任务数据给客户端时，使用完全相同的字符串拼接逻辑（使用 `|||` 分隔）。一旦字段变更，需要修改多处。

### 1.1 创建新模块
*   **路径**：`includes/common/format-job-response.lua`
*   **功能**：接收任务数据对象（Table），返回格式化后的字符串。
*   **预期代码结构**：
    ```lua
    -- 参数 job 是一个包含 id, groupId, payload, attempts 等字段的 table
    local function formatJobResponse(job)
      return job.id .. "|||" .. 
             job.groupId .. "|||" .. 
             job.payload .. "|||" .. 
             job.attempts .. "|||" .. 
             job.maxAttempts .. "|||" .. 
             job.seq .. "|||" .. 
             job.timestamp .. "|||" .. 
             job.orderMs .. "|||" .. 
             job.score .. "|||" .. 
             job.deadline .. "|||" .. 
             (job.isFlowParent or "0") .. "|||" .. 
             job.token
    end
    ```

### 1.2 修改调用方
在以下文件中引入并使用该模块，替换原有的 `return ... .. "|||" .. ...` 拼接代码：
1.  **文件**：`reserve.lua`
2.  **文件**：`reserve-atomic.lua`
3.  **文件**：`reserve-batch.lua`
4.  **文件**：`complete-and-reserve-next-with-metadata.lua`

> **注意**：部分脚本（如 `reserve-batch.lua`）在循环中构造数据，请确保传入 table 结构正确。

---

## 任务 2：提取群组配置更新逻辑 (Group Config Update)

**优先级**：High
**背景**：`enqueue` 相关脚本中存在重复的 JSON 解析和 `HMSET` 更新群组配置的代码块。

### 2.1 创建新模块
*   **路径**：`includes/group-state/update-group-config.lua`
*   **功能**：接收 `ns` (namespace), `groupId`, `configJson`。如果 JSON 有效，解析并更新 Redis Hash。
*   **预期代码结构**：
    ```lua
    local function updateGroupConfig(opts)
      local ns = opts.ns
      local groupId = opts.groupId
      local configJson = opts.configJson
      
      if configJson and configJson ~= "" and configJson ~= "null" then
        local status, config = pcall(cjson.decode, configJson)
        if status and config then
          local configKey = ns .. ":config:" .. groupId
          local args = {}
          for k, v in pairs(config) do
            if v ~= nil then
              table.insert(args, k)
              table.insert(args, tostring(v))
            end
          end
          if #args > 0 then
            redis.call("HMSET", configKey, unpack(args))
          end
        end
      end
    end
    ```

### 2.2 修改调用方
在以下文件中引入并使用该模块，替换原有的 JSON 解析和 `HMSET` 逻辑：
1.  **文件**：`enqueue.lua` (头部区域)
2.  **文件**：`enqueue-flow.lua` (头部区域处理 parentGroupConfig，以及循环内部处理 childGroupConfig)

---

## 任务 3：提取任务数据读取与校验 (Job Data Fetching)

**优先级**：Medium
**背景**：多个脚本使用 `HMGET` 读取任务详情，并手动解构赋值，同时包含相同的“数据损坏检查（Corrupted Check）”逻辑。

### 3.1 创建新模块
*   **路径**：`includes/dal/fetch-job-data.lua`
*   **功能**：根据 JobID 读取所有标准字段，返回 Table。如果 ID 不存在或数据损坏，返回 `nil`。
*   **预期代码结构**：
    ```lua
    local function fetchJobData(opts)
      local ns = opts.ns
      local jobId = opts.jobId
      local jobKey = ns .. ":job:" .. jobId
      
      local job = redis.call("HMGET", jobKey, "id", "groupId", "data", "attempts", "maxAttempts", "seq", "timestamp", "orderMs", "score", "isFlowParent")
      
      -- 基础校验：如果 ID 为空，说明数据损坏或任务已丢失
      if not job[1] or job[1] == false then
        return nil
      end
      
      return {
        id = job[1],
        groupId = job[2],
        payload = job[3],
        attempts = job[4],
        maxAttempts = job[5],
        seq = job[6],
        timestamp = job[7],
        orderMs = job[8],
        score = job[9],
        isFlowParent = job[10]
      }
    end
    ```

### 3.2 修改调用方
在以下文件中引入并使用该模块：
1.  **文件**：`includes/concurrency-control/try-pop-next-job.lua` (替换原有的 HMGET 和 if not id check)
2.  **文件**：`reserve-atomic.lua` (替换原有的 HMGET 逻辑)
3.  **文件**：`complete-and-reserve-next-with-metadata.lua` (替换获取 nextJobKey 数据的部分)

---

## 任务 4：提取幂等性检查逻辑 (Idempotency Check)

**优先级**：Medium
**背景**：`enqueue.lua` 中包含约 50 行极其复杂的幂等性检查代码（判断任务是否存在、是否过期、是否在处理中等），导致主流程难以阅读。

### 4.1 创建新模块
*   **路径**：`includes/job-lifecycle/check-idempotency.lua`
*   **功能**：检查任务是否可以被入队。
*   **参数**：`ns`, `jobId`, `keepCompleted` (boolean/number)。
*   **返回值**：
    *   `"new"`: 全新任务，可以入队。
    *   `"exists"`: 任务已存在且有效，直接返回现有任务。
    *   `"stale"`: 任务键是陈旧的（僵尸键），已清理，视为新任务处理。
*   **预期逻辑**：移动 `enqueue.lua` 中 `Step 2: Handle idempotence` 这一整块逻辑。

### 4.2 修改调用方
1.  **文件**：`enqueue.lua`
    *   调用 `checkIdempotency`。
    *   如果返回 `"exists"`，直接返回 job data。
    *   如果返回 `"new"` 或 `"stale"`，继续执行后续的 `storeJob` 流程。

---

## 任务 5：更新 Loader 定义

**优先级**：High (Must do)
**文件**：`loader.ts`
**操作**：
1.  确保上述新创建的 `.lua` 文件路径被 `loader.ts` 的解析逻辑支持（根据目前的逻辑，只要在 `includes/` 下且正确引用即可，但需要检查文件名是否符合规范）。
2.  无需修改 TS 代码逻辑，但必须确保 AI 在生成新 Lua 文件时路径正确。

---

## 执行顺序建议

1.  先执行 **任务 1** 和 **任务 3**，因为它们是单纯的提取，风险最低。
2.  执行 **任务 2**，稍微涉及逻辑流，但模式清晰。
3.  最后执行 **任务 4**，因为涉及核心入队逻辑，需要仔细比对代码块。