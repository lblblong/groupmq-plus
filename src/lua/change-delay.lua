--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/delayed-handling/promote-delayed-job-complete"

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

-- Check if job is currently in delayed set
local inDelayed = redis.call("ZSCORE", delayedKey, jobId)
-- Check if job is currently in group ZSET
local inGroup = redis.call("ZSCORE", gZ, jobId)

-- If it's not in either, it might be processing or completed/failed
-- We only allow changing delay for waiting or delayed jobs
if not inDelayed and not inGroup then
  return 0
end

-- Update job's delayUntil field
redis.call("HSET", jobKey, "delayUntil", tostring(newDelayUntil))


if newDelayUntil > 0 and newDelayUntil > now then
  -- Job should be delayed: add to delayed set and REMOVE from group ZSET
  redis.call("HSET", jobKey, "status", "delayed")
  redis.call("ZADD", delayedKey, newDelayUntil, jobId)
  redis.call("ZREM", gZ, jobId)
  
  -- Update group status in ready/limited
  local jobCount = redis.call("ZCARD", gZ)
  if jobCount == 0 then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
  else
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
  -- Job should be ready immediately: promote using standard function
  promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)
end

return 1


