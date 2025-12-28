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
local stageKey = ns .. ":stage"
local readyKey = ns .. ":ready"
local delayedKey = ns .. ":delayed"
local groupsKey = ns .. ":groups"
local limitedKey = ns .. ":limited"
local timerKey = ns .. ":stage:timer"

local baseEpoch = 1704067200000
local daysSinceEpoch = math.floor(clientTimestamp / 86400000)
local seqKey = ns .. ":seq:" .. daysSinceEpoch

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
  local delayUntil = job.delayMs and (now + tonumber(job.delayMs)) or 0
  
  -- Idempotence check
  local uniqueKey = ns .. ":unique:" .. jobId
  local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")
  
  if uniqueSet then
    -- Generate sequence and score
    local seq = redis.call("INCR", seqKey)
    local relativeMs = orderMs - baseEpoch
    local score = relativeMs * 1000 + seq
    
    -- Create job hash
    local jobKey = ns .. ":job:" .. jobId
    redis.call("HMSET", jobKey,
      "id", jobId,
      "groupId", groupId,
      "data", data,
      "attempts", "0",
      "maxAttempts", tostring(maxAttempts),
      "seq", tostring(seq),
      "timestamp", tostring(clientTimestamp),
      "orderMs", tostring(orderMs),
      "score", tostring(score),
      "delayUntil", tostring(delayUntil)
    )
    
    -- Add to groups set
    redis.call("SADD", groupsKey, groupId)
    redis.call("HINCRBY", ns .. ":g:" .. groupId .. ":meta", "count", 1)
    
    local gZ = ns .. ":g:" .. groupId
    
    -- Determine job placement
    local jobStatus = "waiting"
    
    if delayUntil > 0 and delayUntil > now then
      -- Delayed job: add to delayed set ONLY
      redis.call("ZADD", delayedKey, delayUntil, jobId)
      jobStatus = "delayed"
      redis.call("HSET", jobKey, "status", jobStatus)
    elseif orderMs and orderingDelayMs > 0 then
      -- Staged job (ordering): add to stage set ONLY
      local releaseAt = orderMs + orderingDelayMs
      redis.call("ZADD", stageKey, releaseAt, jobId)
      jobStatus = "staged"
      redis.call("HSET", jobKey, "status", jobStatus)
    else
      -- Ready to process: add to group ZSET
      redis.call("ZADD", gZ, score, jobId)
      jobStatus = "waiting"
      redis.call("HSET", jobKey, "status", jobStatus)
      -- Mark group for ready queue update (batch later)
      groupsToUpdate[groupId] = true
    end
    
    -- Store job metadata to return
    table.insert(results, {
      jobId,
      groupId,
      data,
      "0", -- attempts
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
    
    if isLimited then
      -- Group already in limited, don't move it to ready
    else
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

-- Update staging timer if needed
if orderingDelayMs > 0 then
  local currentHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
  if currentHead and #currentHead >= 2 then
    local headReleaseAt = tonumber(currentHead[2])
    local ttlMs = math.max(1, headReleaseAt - now)
    redis.call("SET", timerKey, "1", "PX", ttlMs)
  end
end

return results

