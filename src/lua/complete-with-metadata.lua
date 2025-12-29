--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/group-lifecycle/cleanup-if-group-empty"

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
local token = ARGV[12] -- [NEW]

local jobKey = ns .. ":job:" .. jobId
local processingKey = ns .. ":processing"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- [PHASE 3 MODIFICATION START: Get parentId before potentially deleting the job]
local parentId = redis.call("HGET", jobKey, "parentId")
-- [PHASE 3 MODIFICATION END]

-- Part 1: Atomically verify and mark completion (prevent duplicate processing)

-- CRITICAL: Check both status AND processing set membership atomically
-- This prevents race with stalled job recovery
local jobStatus = redis.call("HGET", jobKey, "status")
local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

-- If job is not in "processing" state OR not in processing set, this is late/duplicate
if jobStatus ~= "processing" or not stillInProcessing then
  -- Job was already handled (recovered, failed, or completed by another worker)
  -- Return 0 to indicate this completion was ignored
  return 0
end

-- [NEW] Token verification
local procKey = ns .. ":processing:" .. jobId
local storedToken = redis.call("HGET", procKey, "token")

-- If processing key doesn't exist (already deleted) or token doesn't match
if not storedToken or storedToken ~= token then
  return 0
end

-- Atomically mark as completed and remove from processing
-- This prevents stalled checker from racing with us
redis.call("HSET", jobKey, "status", "completing") -- Temporary status to block stalled checker
redis.call("DEL", procKey)
redis.call("ZREM", processingKey, jobId)

-- Always remove this job from active list to prevent stale entries
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
local activeJobId = redis.call("LINDEX", groupActiveKey, 0)
local wasActive = (activeJobId == jobId)

if wasActive then
  -- Normal case: remove from head of active list
  redis.call("LPOP", groupActiveKey)
else
  -- Race condition: not at head, but still remove to prevent stale entries
  redis.call("LREM", groupActiveKey, 1, jobId)
end

-- [PHYSICAL SEPARATION] Decrement group job count
local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

-- Check if there are more jobs in this group
local gZ = ns .. ":g:" .. gid
local jobCount = redis.call("ZCARD", gZ)
if jobCount == 0 then
  -- Clean up empty group ONLY if no jobs left in any state
  if remainingJobs <= 0 then
    redis.call("DEL", gZ)
    redis.call("DEL", groupActiveKey)
    redis.call("DEL", groupMetaKey)
    redis.call("SREM", ns .. ":groups", gid)
    redis.call("ZREM", ns .. ":ready", gid)
    redis.call("ZREM", limitedKey, gid)
    redis.call("DEL", ns .. ":buffer:" .. gid)
    redis.call("ZREM", ns .. ":buffering", gid)
  else
    -- Group still has delayed/staged jobs, just remove from ready/limited
    redis.call("ZREM", readyKey, gid)
    redis.call("ZREM", limitedKey, gid)
  end
else

  -- Group has more jobs, update ready/limited status based on activeCount
  local groupBufferKey = ns .. ":buffer:" .. gid
  local isBuffering = redis.call("EXISTS", groupBufferKey)
  
  if isBuffering == 0 then
    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
      local nextScore = tonumber(nextHead[2])
      local configKey = ns .. ":config:" .. gid
      local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
      local currentActive = redis.call("LLEN", groupActiveKey)
      
      -- [LIMITED GROUP SET] Check if we can move from limited to ready
      updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, nextScore)
    end
  end
end

-- [PHASE 3 MODIFICATION START: Update Flow Parent]
if parentId then
  local parentKey = ns .. ":job:" .. parentId
  -- 1. Store child result in a separate hash to define parent's "childrenValues"
  -- Key: flow:results:{parentId}, Field: {childId}
  local flowResultsKey = ns .. ":flow:results:" .. parentId
  -- [NEW] 核心变更：包装结果为 {status, data} 结构
  local flowEntry = cjson.encode({
    status = status,
    data = resultOrError
  })
  redis.call("HSET", flowResultsKey, jobId, flowEntry)
  
  -- 2. Decrement remaining counter
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)
  
  -- 3. If all children done, move parent to waiting
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      redis.call("HSET", parentKey, "status", "waiting")
      
      -- Add parent to its group and ready queue
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end
      
      local pGZ = ns .. ":g:" .. parentGroupId
      redis.call("ZADD", pGZ, parentScore, parentId)
      redis.call("SADD", ns .. ":groups", parentGroupId)
      
      -- [LIMITED GROUP SET] Update parent group status based on group capacity
      -- Note: pHead determines the group's priority score for ready/limited queues.
      -- The parent may not be the queue head (if other tasks have lower scores).
      -- We use pHead's score regardless, as it represents the earliest task in the group.
      local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
      if pHead and #pHead >= 2 then
         local pHeadScore = tonumber(pHead[2])
         local pGroupActiveKey = ns .. ":g:" .. parentGroupId .. ":active"
         local pConfigKey = ns .. ":config:" .. parentGroupId
         local pLimit = tonumber(redis.call("HGET", pConfigKey, "concurrency")) or 1
         local pCurrentActive = redis.call("LLEN", pGroupActiveKey)

         updateGroupReadyLimitedState(ns, parentGroupId, readyKey, limitedKey, pHeadScore)
      end
    end
  end
end
-- [PHASE 3 MODIFICATION END]

-- Part 2: Record job metadata (completed or failed)
if status == "completed" then
  local completedKey = ns .. ":completed"
  
  -- CRITICAL: Always set final status first, even if job will be deleted
  -- This ensures any concurrent reads see "completed", not "completing"
  redis.call("HSET", jobKey, "status", "completed")
  
  if keepCompleted > 0 then
    -- Store full job metadata and add to completed set
    redis.call("HSET", jobKey, 
      "processedOn", processedOn,
      "finishedOn", finishedOn,
      "attempts", attempts,
      "maxAttempts", maxAttempts,
      "returnvalue", resultOrError
    )
    redis.call("ZADD", completedKey, timestamp, jobId)
    
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
    redis.call("DEL", ns .. ":unique:" .. jobId)
    redis.call("DEL", ns .. ":flow:results:" .. jobId)
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
    redis.call("ZADD", failedKey, timestamp, jobId)
  else
    -- Delete job (status already set above)
    redis.call("DEL", jobKey)
    redis.call("DEL", ns .. ":unique:" .. jobId)
    redis.call("DEL", ns .. ":flow:results:" .. jobId)
  end
end

-- Publish completion/failure event for waiters
local eventPayload = cjson.encode({
  id = jobId,
  status = status,
  result = resultOrError
})
redis.call("PUBLISH", ns .. ":events", eventPayload)

return 1

