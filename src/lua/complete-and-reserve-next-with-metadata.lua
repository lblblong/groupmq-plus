--- @include "includes/security/verify-token"
--- @include "includes/common/format-job-response"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/flow/update-parent-flow"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Complete a job with metadata and atomically reserve the next job from the same group
-- argv: ns, completedJobId, groupId, status, timestamp, resultOrError, keepCompleted, keepFailed,
--       processedOn, finishedOn, attempts, maxAttempts, now, vt, currentJobToken, nextJobToken
local ns = KEYS[1]
local completedJobId = ARGV[1]
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
local now = tonumber(ARGV[12])
local vt = tonumber(ARGV[13])
local currentJobToken = ARGV[14]
local nextJobToken = ARGV[15]

local processingKey = ns .. ":processing"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

local jobKey = ns .. ":job:" .. completedJobId

-- CRITICAL: Check both status AND processing set membership atomically
-- This prevents race with stalled job recovery
local jobStatus = redis.call("HGET", jobKey, "status")
local stillInProcessing = redis.call("ZSCORE", processingKey, completedJobId)

-- If job is not in "processing" state OR not in processing set, this is late/duplicate
if jobStatus ~= "processing" or not stillInProcessing then
  return nil
end

-- Token verification (moved to dedicated module)
if not verifyToken({ ns = ns, jobId = completedJobId, token = currentJobToken }) then
  return nil
end

-- Get parentId before potentially deleting the job
local parentId = redis.call("HGET", jobKey, "parentId")

-- Atomically mark as completed and remove from processing
-- This prevents stalled checker from racing with us
redis.call("HSET", jobKey, "status", "completing") -- Temporary status to block stalled checker
local procKey = ns .. ":processing:" .. completedJobId
redis.call("DEL", procKey)
redis.call("ZREM", processingKey, completedJobId)

-- Part 3: Record job metadata (completed or failed)

if status == "completed" then
  local completedKey = ns .. ":completed"

  -- CRITICAL: Always set final status first, even if job will be deleted
  -- This ensures any concurrent reads see "completed", not "completing"
  redis.call("HSET", jobKey, "status", "completed")

  -- Update parent flow if this is a child task (moved to dedicated module)
  if parentId then
    updateParentFlow({
      ns = ns,
      parentId = parentId,
      childId = completedJobId,
      status = status,
      resultOrError = resultOrError,
      timestamp = timestamp,
      readyKey = readyKey,
      limitedKey = limitedKey
    })
  end
  
  if keepCompleted > 0 then
    -- Store full job metadata and add to completed set
    redis.call("HSET", jobKey, 
      "processedOn", processedOn,
      "finishedOn", finishedOn,
      "attempts", attempts,
      "maxAttempts", maxAttempts,
      "returnvalue", resultOrError
    )
    redis.call("ZADD", completedKey, timestamp, completedJobId)
    
    -- Trim old entries atomically
    local zcount = redis.call("ZCARD", completedKey)
    local toRemove = zcount - keepCompleted
    if toRemove > 0 then
      local oldIds = redis.call("ZRANGE", completedKey, 0, toRemove - 1)
      if #oldIds > 0 then
        redis.call("ZREMRANGEBYRANK", completedKey, 0, toRemove - 1)
        for i = 1, #oldIds do
          local oldId = oldIds[i]
          redis.call("DEL", ns .. ":job:" .. oldId)
          redis.call("DEL", ns .. ":unique:" .. oldId)
          redis.call("DEL", ns .. ":flow:results:" .. oldId)
        end
      end
    end
  else
    -- keepCompleted == 0: Delete immediately (status already set above)
    redis.call("DEL", jobKey)
    redis.call("DEL", ns .. ":unique:" .. completedJobId)
    redis.call("DEL", ns .. ":flow:results:" .. completedJobId)
  end
  
elseif status == "failed" then
  local failedKey = ns .. ":failed"
  local errorInfo = cjson.decode(resultOrError)
  
  -- CRITICAL: Always set final status first, even if job will be deleted
  redis.call("HSET", jobKey, "status", "failed")
  
  if keepFailed > 0 then
    redis.call("HSET", jobKey,
      "failedReason", errorInfo.message or "Error",
      "failedName", errorInfo.name or "Error",
      "stacktrace", errorInfo.stack or "",
      "processedOn", processedOn,
      "finishedOn", finishedOn,
      "attempts", attempts,
      "maxAttempts", maxAttempts
    )
    redis.call("ZADD", failedKey, timestamp, completedJobId)
  else
    -- Delete job (status already set above)
    redis.call("DEL", jobKey)
    redis.call("DEL", ns .. ":unique:" .. completedJobId)
    redis.call("DEL", ns .. ":flow:results:" .. completedJobId)
  end
end

-- Publish completion/failure event for waiters
local eventPayload = cjson.encode({
  id = completedJobId,
  status = status,
  result = resultOrError
})
redis.call("PUBLISH", ns .. ":events", eventPayload)

-- Part 4: Handle group active list and get next job (BullMQ-style)
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
local activeJobId = redis.call("LINDEX", groupActiveKey, 0)

-- Decrement group job count
local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

-- Check if completed job is at the head of active list
if activeJobId ~= completedJobId then
  -- Race condition: job is not at head (maybe already removed, or wrong job)
  -- Clean it up anyway to prevent stale entries, but don't try to reserve next
  removeJobFromActive({
    ns = ns,
    groupId = gid,
    jobId = completedJobId
  })
  -- Return nil to indicate no chaining
  return nil
end

-- Normal case: this job is at the head of active list
removeJobFromActive({
  ns = ns,
  groupId = gid,
  jobId = completedJobId
})

local gZ = ns .. ":g:" .. gid
local zpop = redis.call("ZPOPMIN", gZ, 1)
if not zpop or #zpop == 0 then
  -- Clean up empty group ONLY if no jobs left in any state
  if remainingJobs <= 0 then
    redis.call("DEL", gZ)
    redis.call("DEL", groupMetaKey)
    redis.call("SREM", ns .. ":groups", gid)
    redis.call("ZREM", readyKey, gid)
    redis.call("ZREM", limitedKey, gid)
  else
    -- Group still has delayed/staged jobs, just remove from ready/limited
    redis.call("ZREM", readyKey, gid)
    redis.call("ZREM", limitedKey, gid)
  end
  -- No next job
  return nil
end

local nextJobId = zpop[1]
local nextJobKey = ns .. ":job:" .. nextJobId
local job = redis.call("HMGET", nextJobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

-- Validate job data exists (handle corrupted/missing job hash)
if not id or id == false then
  -- Job hash is missing/corrupted, clean up and return completion only
  -- Re-add next job to ready queue if exists
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    redis.call("ZADD", readyKey, nextScore, groupId)
  end
  
  -- Return nil to indicate no next job was reserved
  return nil
end

-- Push next job to active list (chaining)
redis.call("LPUSH", groupActiveKey, id)

local procKey = ns .. ":processing:" .. id
local deadline = now + vt
redis.call("HSET", procKey, 
  "groupId", groupId, 
  "deadlineAt", tostring(deadline),
  "token", nextJobToken)

local processingKey = ns .. ":processing"
redis.call("ZADD", processingKey, deadline, id)

-- Mark next job as processing for accurate stalled detection
redis.call("HSET", nextJobKey, "status", "processing")

-- [LIMITED GROUP SET] Update ready/limited status
local configKey = ns .. ":config:" .. gid
local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
local currentActive = redis.call("LLEN", groupActiveKey)

-- Get the score of the NEW head of gZ
local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
if nextHead and #nextHead >= 2 then
  local nextHeadScore = tonumber(nextHead[2])
  updateGroupReadyLimitedState({ ns = ns, groupId = groupId, readyKey = readyKey, limitedKey = limitedKey, headScore = nextHeadScore })
else
  -- No more jobs in gZ
  redis.call("ZREM", readyKey, groupId)
  redis.call("ZREM", limitedKey, groupId)
end

return formatJobResponse({
  id = id,
  groupId = groupId,
  payload = payload,
  attempts = attempts,
  maxAttempts = maxAttempts,
  seq = seq,
  timestamp = enq,
  orderMs = orderMs,
  score = score,
  deadline = deadline,
  isFlowParent = isFlowParent,
  token = nextJobToken
})
