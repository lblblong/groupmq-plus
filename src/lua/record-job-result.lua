--- @include "includes/job-lifecycle/record-job-finalization"

-- Record job completion or failure with retention management
-- argv: ns, jobId, status ('completed' | 'failed'), timestamp, result/error (JSON),
--       keepCompleted, keepFailed, processedOn, finishedOn, attempts, maxAttempts, token
local ns = KEYS[1]
local jobId = ARGV[1]
local status = ARGV[2]
local timestamp = tonumber(ARGV[3])
local resultOrError = ARGV[4]
local keepCompleted = tonumber(ARGV[5])
local keepFailed = tonumber(ARGV[6])
local processedOn = ARGV[7]
local finishedOn = ARGV[8]
local attempts = ARGV[9]
local maxAttempts = ARGV[10]
local token = ARGV[11] -- [NEW] Processing token for verification

local jobKey = ns .. ":job:" .. jobId

-- [NEW] Token verification: Ensure only the correct worker can record final failure
local procKey = ns .. ":processing:" .. jobId
local storedToken = redis.call("HGET", procKey, "token")
if token and (not storedToken or storedToken ~= token) then
  -- Token mismatch: This worker has lost the lock, reject the operation
  return 0
end

-- [PHASE 3 MODIFICATION START: Get parentId before potentially deleting the job]
local parentId = redis.call("HGET", jobKey, "parentId")
-- [PHASE 3 MODIFICATION END]

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Verify job exists and check current status to prevent race conditions
local currentStatus = redis.call("HGET", jobKey, "status")
if not currentStatus then
  -- Job doesn't exist, likely already cleaned up
  return 0
end

-- If job is in "waiting" state, this might be a late completion after stalled recovery
-- In this case, we should not overwrite the status or delete the job
if currentStatus == "waiting" then
  -- Job was recovered by stalled check and possibly being processed by another worker
  -- Ignore this late completion to prevent corruption
  return 0
end

-- [PHASE 3 MODIFICATION START: Update Flow Parent]
-- Regardless of whether the job succeeded or failed, if it's finished, update parent
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
      
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score")) or (tonumber(redis.call("TIME")[1]) * 1000)
      
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
         
         if pCurrentActive >= pLimit then
           -- Parent group is full, move to limited
           redis.call("ZREM", readyKey, parentGroupId)
           redis.call("ZADD", limitedKey, pHeadScore, parentGroupId)
         else
           -- Parent group has slots, move to ready
           redis.call("ZREM", limitedKey, parentGroupId)
           redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
         end
      end
    end
  end
end
-- [PHASE 3 MODIFICATION END]

-- Record job metadata (status, timestamps, metadata)
local keepCount = (status == "completed") and keepCompleted or keepFailed
recordJobFinalization(ns, jobId, status, resultOrError, finishedOn, keepCount, processedOn, attempts, maxAttempts)

-- For completed jobs, ensure idempotence mapping exists
if status == "completed" and keepCompleted > 0 then
  redis.call("SET", ns .. ":unique:" .. jobId, jobId)
end

return 1

