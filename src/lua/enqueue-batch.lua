--- @include "includes/job-lifecycle/store-job"
--- @include "includes/group-state/add-job-to-group"
--- @include "includes/concurrency-control/is-group-at-capacity"

-- Batch enqueue multiple jobs atomically
-- argv: ns, jobsJson, keepCompleted, clientTimestamp, orderingDelayMs
local ns = KEYS[1]
local jobsJson = ARGV[1]
local keepCompleted = tonumber(ARGV[2]) or 0
local clientTimestamp = tonumber(ARGV[3])
local orderingDelayMs = tonumber(ARGV[4]) or 0

local jobs = cjson.decode(jobsJson)

-- Get Redis server time
local timeResult = redis.call("TIME")
local now = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

-- Keys
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Track groups that need ready queue updates
local groupsToUpdate = {}
local results = {}

-- Process all jobs in batch
for i, job in ipairs(jobs) do
  local jobId = job.jobId
  local groupId = job.groupId
  local data = job.data
  local maxAttempts = tonumber(job.maxAttempts)
  local orderMs = tonumber(job.orderMs) or clientTimestamp
  local delayMs = job.delayMs and tonumber(job.delayMs) or 0
  local delayUntil = delayMs > 0 and (now + delayMs) or 0

  -- Idempotence check
  local uniqueKey = ns .. ":unique:" .. jobId
  local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")

  if uniqueSet then
    -- Step 1: Store job data and get score
    local storeOpts = {
      maxAttempts = maxAttempts,
      orderMs = orderMs,
      delayUntil = delayUntil,
      clientTimestamp = clientTimestamp
    }
    local result = storeJob(ns, jobId, groupId, data, storeOpts)
    local score = result[1]

    -- Step 2: Route job to appropriate queue
    local jobStatus = addJobToGroup(ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs)

    -- Mark group for ready queue update if job is waiting (not delayed/staged)
    if jobStatus == "waiting" then
      groupsToUpdate[groupId] = true
    end

    -- Store job metadata to return
    table.insert(results, {
      jobId,
      groupId,
      data,
      "0",
      tostring(maxAttempts),
      tostring(clientTimestamp),
      tostring(orderMs),
      tostring(delayUntil),
      jobStatus,
    })
  else
    -- Job ID already exists (idempotence) - fetch existing job data
    local jobKey = ns .. ":job:" .. jobId
    local jobData = redis.call("HMGET", jobKey, "id", "groupId", "data", "attempts", "maxAttempts", "timestamp", "orderMs", "delayUntil", "status")
    if jobData[1] then
      table.insert(results, jobData)
    else
      -- Shouldn't happen but handle gracefully
      table.insert(results, {
        jobId,
        groupId,
        data,
        "0",
        tostring(maxAttempts),
        tostring(clientTimestamp),
        tostring(orderMs),
        tostring(delayUntil),
        "waiting",
      })
    end
  end
end

-- Batch update ready queue for all affected groups
for groupId, _ in pairs(groupsToUpdate) do
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])

    -- [LIMITED GROUP SET] Check if group is already in limited
    local isLimited = redis.call("ZSCORE", limitedKey, groupId)

    if not isLimited then
      -- Group not in limited, check capacity
      local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
      local configKey = ns .. ":config:" .. groupId
      local currentActive = redis.call("LLEN", groupActiveKey)
      local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

      if currentActive >= limit then
        -- Group is full, add to limited
        redis.call("ZADD", limitedKey, headScore, groupId)
      else
        -- Group has capacity, add to ready
        redis.call("ZADD", readyKey, headScore, groupId)
      end
    end
  end
end

return results

