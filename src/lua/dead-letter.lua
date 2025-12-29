--- @include "includes/concurrency-control/is-group-at-capacity"

-- argv: ns, jobId, groupId, token
local ns = KEYS[1]
local jobId = ARGV[1]
local groupId = ARGV[2]
local token = ARGV[3] -- [NEW] Processing token for verification
local gZ = ns .. ":g:" .. groupId
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

local jobKey = ns .. ":job:" .. jobId

-- Token verification: Ensure only the correct worker can dead-letter the job
local procKey = ns .. ":processing:" .. jobId
local storedToken = redis.call("HGET", procKey, "token")

-- If job still has a lock (processing) and token doesn't match, reject dead-letter
if storedToken and storedToken ~= token then
  return 0 -- Lock mismatch: another worker is processing this job
end
-- If no stored token but token was provided, also reject (safety: prevent dead-lettering recovered jobs)
if not storedToken and token then
  return 0
end

-- Remove job from group
redis.call("ZREM", gZ, jobId)
redis.call("ZREM", ns .. ":delayed", jobId)

-- [PHYSICAL SEPARATION] Decrement group job count
local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

-- Remove from processing if it's there
redis.call("DEL", procKey)
redis.call("ZREM", ns .. ":processing", jobId)

-- No counter operations - use ZCARD for counts

-- Remove idempotence mapping to allow reuse
redis.call("DEL", ns .. ":unique:" .. jobId)

-- BullMQ-style: Remove from group active list if present
local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)

-- Check if group is now empty or should be removed from ready queue
if remainingJobs <= 0 then
  -- Group is empty, remove from ready and limited queues and clean up
  redis.call("ZREM", readyKey, groupId)
  redis.call("ZREM", limitedKey, groupId)
  redis.call("DEL", gZ)
  redis.call("DEL", groupMetaKey)
  redis.call("DEL", groupActiveKey)
  redis.call("SREM", ns .. ":groups", groupId)
else
  -- Group still has jobs, check if it can go to ready or should stay in limited
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])

    -- [LIMITED GROUP SET] Check if we can move from limited to ready
    if not isGroupAtCapacity(ns, groupId) then
      redis.call("ZREM", limitedKey, groupId)
      redis.call("ZADD", readyKey, headScore, groupId)
    else
      -- Still full, ensure in limited
      redis.call("ZREM", readyKey, groupId)
      redis.call("ZADD", limitedKey, headScore, groupId)
    end
  end
end

-- Optionally store in dead letter queue (uncomment if needed)
-- redis.call("LPUSH", ns .. ":dead", jobId)

-- [DELETED: Flow logic removed to avoid double-decrementing flowRemaining]
-- The flow update is handled by record-job-result.lua which is called 
-- immediately before dead-letter.lua in the worker's deadLetterJob method.

return 1

