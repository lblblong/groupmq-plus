--- @include "includes/security/verify-token"
--- @include "includes/common/format-job-response"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/flow/update-parent-flow"
--- @include "includes/group-lifecycle/refresh-group-state"
--- @include "includes/concurrency-control/try-pop-next-job"
--- @include "includes/lock/release-lock"

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

-- [BullMQ 风格] 释放独立锁
releaseLock({ ns = ns, jobId = completedJobId, token = currentJobToken })

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

-- Part 4: Handle group active list and reserve next job using unified module
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
local activeJobId = redis.call("LINDEX", groupActiveKey, 0)

-- Decrement group job count
local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
redis.call("HINCRBY", groupMetaKey, "count", -1)

-- Check if completed job is at the head of active list
if activeJobId ~= completedJobId then
  -- Race condition: job is not at head
  -- Clean it up anyway to prevent stale entries, but don't try to reserve next
  removeJobFromActive({
    ns = ns,
    groupId = gid,
    jobId = completedJobId
  })
  -- 更新群组状态（可能为空或需要从 ready/limited 重新评估）
  refreshGroupState({
    ns = ns,
    groupId = gid,
    readyKey = readyKey,
    limitedKey = limitedKey
  })
  -- Return nil to indicate no chaining
  return nil
end

-- Normal case: this job is at the head of active list
-- [FIXED]: Do NOT remove job from active list yet. 
-- We need it to be present for tryPopNextJob's allowedJobId check to work.
-- If we remove it first, tryPopNextJob won't find it in the list and will deny the exemption 
-- if the group is at/over capacity.

-- 使用统一的出队模块尝试预留下一个任务
-- allowedJobId = completedJobId 确保刚完成的任务还在列表中时，有豁免权让下一个任务进来（1 换 1）
local nextJob = tryPopNextJob({
  ns = ns,
  groupId = gid,
  vt = vt,
  token = nextJobToken,
  now = now,
  processingKey = processingKey,
  allowedJobId = completedJobId  -- 豁免权：刚完成的任务
})

-- [FIXED]: Now remove the old job from active list.
-- Since tryPopNextJob adds new job to head (LPUSH), our old job is likely at index 1.
-- removeJobFromActive handles this safely (falls back to LREM if not at head).
removeJobFromActive({
  ns = ns,
  groupId = gid,
  jobId = completedJobId
})

-- 如果没有下一个任务，清理群组并更新状态
if not nextJob then
  refreshGroupState({
    ns = ns,
    groupId = gid,
    readyKey = readyKey,
    limitedKey = limitedKey
  })
  -- Return nil to indicate no next job was reserved
  return nil
end

-- 群组中还有任务，更新 ready/limited 状态
-- Module will handle both empty and non-empty group cases
refreshGroupState({
  ns = ns,
  groupId = gid,
  readyKey = readyKey,
  limitedKey = limitedKey
})

return formatJobResponse({
  id = nextJob.jobId,
  groupId = nextJob.groupId,
  payload = nextJob.payload,
  attempts = nextJob.attempts,
  maxAttempts = nextJob.maxAttempts,
  seq = nextJob.seq,
  timestamp = nextJob.timestamp,
  orderMs = nextJob.orderMs,
  score = nextJob.score,
  deadline = nextJob.deadline,
  isFlowParent = nextJob.isFlowParent,
  token = nextJobToken,
  parentId = nextJob.parentId
})
