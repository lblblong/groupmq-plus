--- @include "includes/job-lifecycle/store-job"
--- @include "includes/group-state/add-job-to-group"
--- @include "includes/group-state/update-group-config"
--- @include "includes/job-lifecycle/check-idempotency"

-- argv: ns, groupId, dataJson, maxAttempts, orderMs, delayUntil, jobId, keepCompleted, clientTimestamp, orderingDelayMs, groupConfigJson
local ns = KEYS[1]
local groupId = ARGV[1]
local data = ARGV[2]
local maxAttempts = tonumber(ARGV[3])
local orderMs = tonumber(ARGV[4])
local delayUntil = tonumber(ARGV[5])
local jobId = ARGV[6]
local keepCompleted = tonumber(ARGV[7]) or 0
local clientTimestamp = tonumber(ARGV[8])
local orderingDelayMs = tonumber(ARGV[9]) or 0
local groupConfigJson = ARGV[10]

-- Step 1: Update group config
updateGroupConfig({
  ns = ns,
  groupId = groupId,
  configJson = groupConfigJson
})

-- Step 2: Handle idempotence
local idempotencyResult = checkIdempotency({
  ns = ns,
  jobId = jobId,
  keepCompleted = keepCompleted
})

if idempotencyResult == "exists" then
  return jobId
elseif idempotencyResult == "stale" then
  -- Stale key was cleaned, continue with new job creation
elseif idempotencyResult == "new" then
  -- New job, continue with creation
end

-- Step 3: Store job data and get score/seq
local result = storeJob({
  ns = ns,
  jobId = jobId,
  groupId = groupId,
  data = data,
  maxAttempts = maxAttempts,
  orderMs = orderMs,
  delayUntil = delayUntil,
  clientTimestamp = clientTimestamp
})
local score = result[1]

-- Step 4: Route job to appropriate queue
local jobStatus = addJobToGroup({
  ns = ns,
  groupId = groupId,
  jobId = jobId,
  score = score,
  delayUntil = delayUntil,
  orderMs = orderMs,
  orderingDelayMs = orderingDelayMs
})

-- Return job data to avoid race condition where job might be processed & cleaned up
-- before getJob() is called
return {jobId, groupId, data, "0", tostring(maxAttempts), tostring(clientTimestamp or tonumber(redis.call("TIME")[1]) * 1000), tostring(orderMs), tostring(delayUntil), jobStatus}


