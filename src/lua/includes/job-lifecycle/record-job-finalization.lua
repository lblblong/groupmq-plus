-- 入参: ns, jobId, status, resultOrError, finishedOn, keepCount, processedOn, attempts, maxAttempts
-- 功能: 原子性地记录完成/失败状态，应用保留策略
-- status: "completed" 或 "failed"
-- keepCount: 保留记录数，0表示立即删除
-- 返回: "recorded"

local function recordJobFinalization(ns, jobId, status, resultOrError, finishedOn, keepCount, processedOn, attempts, maxAttempts)
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

