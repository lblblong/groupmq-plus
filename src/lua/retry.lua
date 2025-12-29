--- @include "includes/concurrency-control/is-group-at-capacity"

-- argv: ns, jobId, backoffMs, token
local ns = KEYS[1]
local jobId = ARGV[1]
local backoffMs = tonumber(ARGV[2]) or 0
local token = ARGV[3] -- [NEW] Processing token for verification

local jobKey = ns .. ":job:" .. jobId
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Token verification: strict consistency
local procKey = ns .. ":processing:" .. jobId
local storedToken = redis.call("HGET", procKey, "token")

-- If job still has a lock (processing) and token doesn't match, reject retry
if storedToken and storedToken ~= token then
  return -2 -- LockLost: another worker is processing this job
end
-- If no stored token but token was provided, also reject (safety: prevent retry on recovered jobs)
if not storedToken and token then
  return -2 -- LockLost: job was recovered/cleared, token is stale
end

local gid = redis.call("HGET", jobKey, "groupId")
local attempts = tonumber(redis.call("HINCRBY", jobKey, "attempts", 1))
local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts"))

-- [CRITICAL FIX 1]: Check limits BEFORE deleting the lock.
-- If we return -1, we MUST preserve the lock/token so that recordFinalFailure 
-- (called next by the worker) can pass its token verification.
-- [CRITICAL FIX 2]: Use >= instead of >. If attempts reaches max, we stop.
if attempts >= maxAttempts then
  return -1
end

-- Only delete lock if we are actually queuing for retry (releasing to pool)
redis.call("DEL", procKey)
redis.call("ZREM", ns .. ":processing", jobId)

-- BullMQ-style: Remove from group active list
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)

local score = tonumber(redis.call("HGET", jobKey, "score"))
local gZ = ns .. ":g:" .. gid

-- If backoffMs > 0, delay the retry
if backoffMs > 0 then
  local now = tonumber(redis.call("TIME")[1]) * 1000
  local delayUntil = now + backoffMs
  
  -- Move to delayed set ONLY (physical separation)
  local delayedKey = ns .. ":delayed"
  redis.call("ZADD", delayedKey, delayUntil, jobId)
  redis.call("HSET", jobKey, "runAt", tostring(delayUntil), "status", "delayed", "delayUntil", tostring(delayUntil))
  
  -- Ensure it's NOT in group ZSET
  redis.call("ZREM", gZ, jobId)
  
  -- If group is now empty, remove from ready/limited
  local jobCount = redis.call("ZCARD", gZ)
  if jobCount == 0 then
    redis.call("ZREM", readyKey, gid)
    redis.call("ZREM", limitedKey, gid)
  else
    -- Update group score in ready/limited if it was the head
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      if redis.call("ZSCORE", readyKey, gid) then
        redis.call("ZADD", readyKey, headScore, gid)
      elseif redis.call("ZSCORE", limitedKey, gid) then
        redis.call("ZADD", limitedKey, headScore, gid)
      end
    end
  end
else
  -- No backoff - immediate retry, add back to group ZSET
  redis.call("ZADD", gZ, score, jobId)
  redis.call("HSET", jobKey, "status", "waiting")
  redis.call("HDEL", jobKey, "runAt", "delayUntil")
  
  -- [LIMITED GROUP SET] Check if group is full and update ready/limited accordingly
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])

    if isGroupAtCapacity(ns, gid) then
      -- Group is full, move to limited
      redis.call("ZREM", readyKey, gid)
      redis.call("ZADD", limitedKey, headScore, gid)
    else
      -- Group has slots, move to ready
      redis.call("ZREM", limitedKey, gid)
      redis.call("ZADD", readyKey, headScore, gid)
    end
  end
end

return attempts
