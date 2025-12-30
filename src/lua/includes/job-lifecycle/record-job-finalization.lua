--[[
  记录任务完成/失败状态 (Record Job Finalization)
  
  原子性地记录完成/失败状态，应用保留策略
  
  @param options table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - status: string "completed" 或 "failed"
    - resultOrError: string 结果或错误信息 (JSON)
    - finishedOn: string 完成时间戳
    - keepCount: number 保留记录数，0表示立即删除
    - processedOn: string 处理开始时间戳 (可选)
    - attempts: string 尝试次数 (可选)
    - maxAttempts: string 最大尝试次数 (可选)
  
  @return string "recorded"
]]

local function recordJobFinalization(options)
  -- 参数解构
  local ns = options.ns
  local jobId = options.jobId
  local status = options.status
  local resultOrError = options.resultOrError
  local finishedOn = options.finishedOn
  local keepCount = options.keepCount
  local processedOn = options.processedOn
  local attempts = options.attempts
  local maxAttempts = options.maxAttempts

  local jobKey = ns .. ":job:" .. jobId
  local statusKey = (status == "completed") and (ns .. ":completed") or (ns .. ":failed")

  -- 记录状态和时间戳
  redis.call("HSET", jobKey, "status", status, "finishedOn", finishedOn)

  -- 根据状态保存完整元数据
  if status == "completed" then
    redis.call("HSET", jobKey,
      "processedOn", processedOn or "",
      "attempts", attempts or "",
      "maxAttempts", maxAttempts or "",
      "returnvalue", resultOrError
    )
  elseif status == "failed" then
    local errorInfo = cjson.decode(resultOrError)
    redis.call("HSET", jobKey,
      "failedReason", errorInfo.message or "Error",
      "failedName", errorInfo.name or "Error",
      "stacktrace", errorInfo.stack or "",
      "processedOn", processedOn or "",
      "attempts", attempts or "",
      "maxAttempts", maxAttempts or ""
    )
  end

  if keepCount and keepCount > 0 then
    -- 保存到完成/失败集合
    redis.call("ZADD", statusKey, finishedOn, jobId)

    -- 修剪旧的记录
    local zcount = redis.call("ZCARD", statusKey)
    local toRemove = zcount - keepCount
    if toRemove > 0 then
      local oldIds = redis.call("ZRANGE", statusKey, 0, toRemove - 1)
      for _, oldId in ipairs(oldIds) do
        redis.call("DEL", ns .. ":job:" .. oldId)
      end
      redis.call("ZREMRANGEBYRANK", statusKey, 0, toRemove - 1)
    end
  else
    -- keepCount == 0: 立即删除
    redis.call("DEL", jobKey)
  end

  -- 发布事件
  redis.call("PUBLISH", ns .. ":events", cjson.encode({
    id = jobId,
    status = status,
    result = resultOrError
  }))

  return "recorded"
end
