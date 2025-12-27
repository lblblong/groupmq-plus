-- argv: ns, jobId, newDelayUntil, now
local ns = KEYS[1]
local jobId = ARGV[1]
local newDelayUntil = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Validate required parameters
if not newDelayUntil or not now then
  return 0
end

local jobKey = ns .. ":job:" .. jobId
local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Check if job exists
local exists = redis.call("EXISTS", jobKey)
if exists == 0 then
  return 0
end

local groupId = redis.call("HGET", jobKey, "groupId")
if not groupId then
  return 0
end

local gZ = ns .. ":g:" .. groupId

-- Check if job is still in group (not deleted)
local jobInGroup = redis.call("ZSCORE", gZ, jobId)
if not jobInGroup then
  return 0
end

-- Update job's delayUntil field
redis.call("HSET", jobKey, "delayUntil", tostring(newDelayUntil))

-- Check if job is currently in delayed set
local inDelayed = redis.call("ZSCORE", delayedKey, jobId)

if newDelayUntil > 0 and newDelayUntil > now then
  -- Job should be delayed
  redis.call("HSET", jobKey, "status", "delayed")
  redis.call("ZADD", delayedKey, newDelayUntil, jobId)
  -- If this is the head job and wasn't already delayed, remove group from ready
  if not inDelayed then
    local head = redis.call("ZRANGE", gZ, 0, 0)
    if head and #head > 0 and head[1] == jobId then
      redis.call("ZREM", readyKey, groupId)
    end
  end
else
  -- Job should be ready immediately
  redis.call("HSET", jobKey, "status", "waiting")
  if inDelayed then
    -- Remove from delayed
    redis.call("ZREM", delayedKey, jobId)
  end
  -- [LIMITED GROUP SET] If this is the head job, check group capacity
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 and head[1] == jobId then
    local headScore = tonumber(head[2])
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
    local configKey = ns .. ":config:" .. groupId
    local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
    local currentActive = redis.call("LLEN", groupActiveKey)
    
    if currentActive >= limit then
      -- Group is full, move to limited
      redis.call("ZREM", readyKey, groupId)
      redis.call("ZADD", limitedKey, headScore, groupId)
    else
      -- Group has slots, move to ready
      redis.call("ZREM", limitedKey, groupId)
      redis.call("ZADD", readyKey, headScore, groupId)
    end
  end
end

return 1


