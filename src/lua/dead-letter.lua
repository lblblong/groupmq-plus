--- @include "includes/security/verify-token"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- argv: ns, jobId, groupId, token
local ns = KEYS[1]
local jobId = ARGV[1]
local groupId = ARGV[2]
local token = ARGV[3]
local gZ = ns .. ":g:" .. groupId
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

local jobKey = ns .. ":job:" .. jobId

-- Token verification: Ensure only the correct worker can dead-letter the job
-- Special handling: dead-letter can proceed if token is missing (job already recovered)
-- but reject if token exists and doesn't match
local procKey = ns .. ":processing:" .. jobId
local storedToken = redis.call("HGET", procKey, "token")

if storedToken and storedToken ~= token then
  -- Lock mismatch: another worker is processing this job
  return 0
end
if not storedToken and token then
  -- Safety: prevent dead-lettering recovered jobs
  return 0
end

-- Remove job from group
redis.call("ZREM", gZ, jobId)
redis.call("ZREM", ns .. ":delayed", jobId)

-- Decrement group job count
local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

-- Remove from processing if it's there
redis.call("DEL", procKey)
redis.call("ZREM", ns .. ":processing", jobId)

-- Remove idempotence mapping to allow reuse
redis.call("DEL", ns .. ":unique:" .. jobId)

-- Remove from group active list if present (moved to dedicated module)
removeJobFromActive(ns, groupId, jobId)

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
    updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
  end
end

-- Optionally store in dead letter queue (uncomment if needed)
-- redis.call("LPUSH", ns .. ":dead", jobId)

-- [DELETED: Flow logic removed to avoid double-decrementing flowRemaining]
-- The flow update is handled by record-job-result.lua which is called 
-- immediately before dead-letter.lua in the worker's deadLetterJob method.

return 1

