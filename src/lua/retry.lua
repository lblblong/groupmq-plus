-- argv: ns, jobId, backoffMs
local ns = KEYS[1]
local jobId = ARGV[1]
local backoffMs = tonumber(ARGV[2]) or 0

local jobKey = ns .. ":job:" .. jobId
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local gid = redis.call("HGET", jobKey, "groupId")
local attempts = tonumber(redis.call("HINCRBY", jobKey, "attempts", 1))
local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts"))

redis.call("DEL", ns .. ":processing:" .. jobId)
redis.call("ZREM", ns .. ":processing", jobId)

-- BullMQ-style: Remove from group active list
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)

if attempts > maxAttempts then
  return -1
end

local score = tonumber(redis.call("HGET", jobKey, "score"))
local gZ = ns .. ":g:" .. gid

-- Re-add job to group
redis.call("ZADD", gZ, score, jobId)

-- If backoffMs > 0, delay the retry
if backoffMs > 0 then
  local now = tonumber(redis.call("TIME")[1]) * 1000
  local delayUntil = now + backoffMs
  
  -- Move to delayed set
  local delayedKey = ns .. ":delayed"
  redis.call("ZADD", delayedKey, delayUntil, jobId)
  redis.call("HSET", jobKey, "runAt", tostring(delayUntil), "status", "delayed")
  
  -- Don't add to ready yet - will be added when promoted
  -- (delayed jobs block their group)
else
  -- No backoff - immediate retry
  redis.call("HSET", jobKey, "status", "waiting")
  
  -- [LIMITED GROUP SET] Check if group is full and update ready/limited accordingly
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])
    local groupActiveKey = ns .. ":g:" .. gid .. ":active"
    local configKey = ns .. ":config:" .. gid
    local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
    local currentActive = redis.call("LLEN", groupActiveKey)
    
    if currentActive >= limit then
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
