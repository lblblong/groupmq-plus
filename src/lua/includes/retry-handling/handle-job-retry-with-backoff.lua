--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/concurrency-control/is-group-at-capacity"

-- 入参: ns, jobId, groupId, token, backoffMs
-- 功能: 处理任务重试，包括令牌验证、尝试次数检查、延迟或立即重试
-- 返回: -2 (token不匹配) | -1 (超过最大尝试次数) | attempts次数 (成功重试)

local function handleJobRetryWithBackoff(ns, jobId, groupId, token, backoffMs)
  local jobKey = ns .. ":job:" .. jobId
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  -- 令牌验证
  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  if storedToken and storedToken ~= token then
    return -2 -- 令牌不匹配，任务已被其他worker接管
  end

  if not storedToken and token then
    return -2 -- 不安全：任务已被清理，令牌已失效
  end

  local attempts = tonumber(redis.call("HINCRBY", jobKey, "attempts", 1))
  local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts"))

  -- 检查是否超过最大尝试次数
  if attempts >= maxAttempts then
    return -1 -- 超过最大次数，不进行重试
  end

  -- 只有在实际进行重试时才删除锁
  redis.call("DEL", procKey)
  redis.call("ZREM", ns .. ":processing", jobId)

  -- 从活跃列表移除
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
  redis.call("LREM", groupActiveKey, 1, jobId)

  local score = tonumber(redis.call("HGET", jobKey, "score"))
  local gZ = ns .. ":g:" .. groupId

  backoffMs = backoffMs or 0

  if backoffMs > 0 then
    -- 带延迟的重试
    local now = tonumber(redis.call("TIME")[1]) * 1000
    local delayUntil = now + backoffMs

    -- 移到延迟集合（物理分离）
    local delayedKey = ns .. ":delayed"
    redis.call("ZADD", delayedKey, delayUntil, jobId)
    redis.call("HSET", jobKey, "runAt", tostring(delayUntil), "status", "delayed", "delayUntil", tostring(delayUntil))

    -- 确保不在群组ZSET中
    redis.call("ZREM", gZ, jobId)

    -- 如果群组为空，从ready/limited中移除
    local jobCount = redis.call("ZCARD", gZ)
    if jobCount == 0 then
      redis.call("ZREM", readyKey, groupId)
      redis.call("ZREM", limitedKey, groupId)
    else
      -- 群组仍有任务，更新群组分数
      local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if head and #head >= 2 then
        local headScore = tonumber(head[2])
        if redis.call("ZSCORE", readyKey, groupId) then
          redis.call("ZADD", readyKey, headScore, groupId)
        elseif redis.call("ZSCORE", limitedKey, groupId) then
          redis.call("ZADD", limitedKey, headScore, groupId)
        end
      end
    end
  else
    -- 立即重试，加回群组ZSET
    redis.call("ZADD", gZ, score, jobId)
    redis.call("HSET", jobKey, "status", "waiting")
    redis.call("HDEL", jobKey, "runAt", "delayUntil")

    -- 检查群组容量，更新ready/limited状态
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])

      if isGroupAtCapacity(ns, groupId) then
        -- 群组已满，移到limited
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZADD", limitedKey, headScore, groupId)
      else
        -- 群组有空位，移到ready
        redis.call("ZREM", limitedKey, groupId)
        redis.call("ZADD", readyKey, headScore, groupId)
      end
    end
  end

  return attempts
end

