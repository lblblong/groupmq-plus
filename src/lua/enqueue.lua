--- @include "includes/job-lifecycle/store-job"
--- @include "includes/group-state/add-job-to-group"

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
if groupConfigJson and groupConfigJson ~= "" and groupConfigJson ~= "null" then
  local status, config = pcall(cjson.decode, groupConfigJson)
  if status and config then
    local configKey = ns .. ":config:" .. groupId
    local args = {}
    for k, v in pairs(config) do
      if v ~= nil then
        table.insert(args, k)
        table.insert(args, tostring(v))
      end
    end
    if #args > 0 then
      redis.call("HMSET", configKey, unpack(args))
    end
  end
end

local jobKey = ns .. ":job:" .. jobId

-- Step 2: Handle idempotence
local uniqueKey = ns .. ":unique:" .. jobId
local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")
if not uniqueSet then
  -- Duplicate detected. Check for stale unique mapping
  local exists = redis.call("EXISTS", jobKey)
  if exists == 0 then
    -- Job doesn't exist but unique key does (stale), clean up and proceed
    redis.call("DEL", uniqueKey)
    redis.call("SET", uniqueKey, jobId)
  else
    -- Job exists, check its status and location
    local gid = redis.call("HGET", jobKey, "groupId")
    local inProcessing = redis.call("ZSCORE", ns .. ":processing", jobId)
    local inDelayed = redis.call("ZSCORE", ns .. ":delayed", jobId)
    local inGroup = nil
    if gid then
      inGroup = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
    end
    if (not inProcessing) and (not inDelayed) and (not inGroup) then
      if keepCompleted == 0 then
        redis.call("DEL", jobKey)
        redis.call("DEL", uniqueKey)
        redis.call("SET", uniqueKey, jobId)
      else
        -- Job hash exists and we're keeping completed jobs, ensure unique key exists
        redis.call("SET", uniqueKey, jobId)
        return jobId
      end
    else
      if keepCompleted == 0 then
        local jobStatus = redis.call("HGET", jobKey, "status")
        if jobStatus == "completed" then
          redis.call("DEL", jobKey)
          redis.call("DEL", uniqueKey)
          redis.call("SET", uniqueKey, jobId)
        else
          -- Job is still active, ensure unique key exists
          redis.call("SET", uniqueKey, jobId)
          return jobId
        end
      end
      local activeAgain = redis.call("ZSCORE", ns .. ":processing", jobId)
      local delayedAgain = redis.call("ZSCORE", ns .. ":delayed", jobId)
      local inGroupAgain = nil
      if gid then
        inGroupAgain = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
      end
      local jobStillExists = redis.call("EXISTS", jobKey)
      if jobStillExists == 1 and (activeAgain or delayedAgain or inGroupAgain) then
        return jobId
      end
    end
  end
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


