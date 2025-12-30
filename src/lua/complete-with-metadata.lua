--- @include "includes/security/verify-token"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/flow/update-parent-flow"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/group-lifecycle/cleanup-if-group-empty"
--- @include "includes/job-lifecycle/record-job-finalization"
--- @include "includes/group-status/get-group-head-job"

-- Complete a job: unlock group AND record metadata atomically in one call
-- argv: ns, jobId, groupId, status, timestamp, resultOrError, keepCompleted, keepFailed,
--       processedOn, finishedOn, attempts, maxAttempts, token
local ns = KEYS[1]
local jobId = ARGV[1]
local gid = ARGV[2]
local status = ARGV[3]
local timestamp = tonumber(ARGV[4])
local resultOrError = ARGV[5]
local keepCompleted = tonumber(ARGV[6])
local keepFailed = tonumber(ARGV[7])
local processedOn = ARGV[8]
local finishedOn = ARGV[9]
local attempts = ARGV[10]
local maxAttempts = ARGV[11]
local token = ARGV[12]

local jobKey = ns .. ":job:" .. jobId
local processingKey = ns .. ":processing"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Get parentId before potentially deleting the job
local parentId = redis.call("HGET", jobKey, "parentId")

-- Part 1: Atomically verify and mark completion (prevent duplicate processing)

-- CRITICAL: Check both status AND processing set membership atomically
-- This prevents race with stalled job recovery
local jobStatus = redis.call("HGET", jobKey, "status")
local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

-- If job is not in "processing" state OR not in processing set, this is late/duplicate
if jobStatus ~= "processing" or not stillInProcessing then
  -- Job was already handled (recovered, failed, or completed by another worker)
  return 0
end

-- Token verification (moved to dedicated module)
if not verifyToken(ns, jobId, token) then
  return 0
end

-- Atomically mark as completed and remove from processing
redis.call("HSET", jobKey, "status", "completing") -- Temporary status to block stalled checker
local procKey = ns .. ":processing:" .. jobId
redis.call("DEL", procKey)
redis.call("ZREM", processingKey, jobId)

-- Remove job from active list (moved to dedicated module)
removeJobFromActive(ns, gid, jobId)

-- Decrement group job count
local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
redis.call("HINCRBY", groupMetaKey, "count", -1)

-- Check if there are more jobs in this group and update status
local nextJobId = getGroupHeadJob(ns, gid)
if nextJobId then
  -- Group has more jobs, update ready/limited status
  local gZ = ns .. ":g:" .. gid
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, nextScore)
  end
else
  -- No more jobs, clean up the group
  cleanupIfGroupEmpty(ns, gid)
end

-- Part 2: Update parent flow if this is a child task
if parentId then
  updateParentFlow(ns, parentId, jobId, status, resultOrError, timestamp, readyKey, limitedKey)
end

-- Part 3: Record job metadata (completed or failed)
local keepCount = (status == "completed") and keepCompleted or keepFailed
recordJobFinalization(ns, jobId, status, resultOrError, finishedOn, keepCount, processedOn, attempts, maxAttempts)

return 1

