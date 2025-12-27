-- argv: ns, now
local ns = KEYS[1]
local now = tonumber(ARGV[1])

local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Find one job that is due now
local ids = redis.call("ZRANGEBYSCORE", delayedKey, 0, now, "LIMIT", 0, 1)
if not ids or #ids == 0 then
  return 0
end

local jobId = ids[1]

-- Try to remove it atomically; if another scheduler raced, ZREM will return 0
local removed = redis.call("ZREM", delayedKey, jobId)
if removed == 0 then
  return 0
end

-- Determine its group and update ready queue if it was the head
local jobKey = ns .. ":job:" .. jobId
local groupId = redis.call("HGET", jobKey, "groupId")
if not groupId then
  return 1 -- treat as moved even if metadata missing
end

-- Mark job as waiting (no longer delayed)
redis.call("HSET", jobKey, "status", "waiting")
redis.call("HDEL", jobKey, "runAt")

local gZ = ns .. ":g:" .. groupId
local head = redis.call("ZRANGE", gZ, 0, 0)
if head and #head > 0 and head[1] == jobId then
  local headScore = redis.call("ZSCORE", gZ, jobId)
  if headScore then
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
    local configKey = ns .. ":config:" .. groupId
    local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
    local currentActive = redis.call("LLEN", groupActiveKey)
    
    -- [LIMITED GROUP SET] Check group capacity
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


