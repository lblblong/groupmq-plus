--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/ghost-cleanup/detect-ghost-tasks"

-- argv: ns, nowEpochMs, vtMs, scanLimit, token
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local scanLimit = tonumber(ARGV[3]) or 20
local token = ARGV[4] -- [NEW]

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Respect paused state
if redis.call("GET", ns .. ":paused") then
  return nil
end

-- STALLED JOB RECOVERY WITH THROTTLING
-- Check for stalled jobs periodically to avoid overhead in hot path
-- This ensures stalled jobs are recovered even in high-load systems
-- Check interval is adaptive: 1/4 of jobTimeout (to check 4x during visibility window), max 5s
local processingKey = ns .. ":processing"
local stalledCheckKey = ns .. ":stalled:lastcheck"
local lastCheck = tonumber(redis.call("GET", stalledCheckKey)) or 0
local stalledCheckInterval = math.min(math.floor(vt / 4), 5000)

local shouldCheckStalled = (now - lastCheck) >= stalledCheckInterval

-- Get available groups
local groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")

-- Check for stalled jobs if: queue is empty OR it's time for periodic check
if (not groups or #groups == 0) or shouldCheckStalled then
  if shouldCheckStalled then
    redis.call("SET", stalledCheckKey, tostring(now))
  end
  
  local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
  for _, jobId in ipairs(expiredJobs) do
    local procKey = ns .. ":processing:" .. jobId
    local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
    local gid = procData[1]
    local deadlineAt = tonumber(procData[2])
    if gid and deadlineAt and now > deadlineAt then
      local jobKey = ns .. ":job:" .. jobId
      local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
      local jobScore = tonumber(jobData[1])
      local delayUntil = tonumber(jobData[2] or "0")
      
      if jobScore then
        local gZ = ns .. ":g:" .. gid
        
        if delayUntil > 0 and delayUntil > now then
          -- [PHYSICAL SEPARATION] Job is still delayed, add to delayed set ONLY
          redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
          redis.call("HSET", jobKey, "status", "delayed")
          
          -- Update group status in ready/limited (it might have been the head)
          local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
          if head and #head >= 2 then
            local headScore = tonumber(head[2])
            if redis.call("ZSCORE", readyKey, gid) then
              redis.call("ZADD", readyKey, headScore, gid)
            elseif redis.call("ZSCORE", limitedKey, gid) then
              redis.call("ZADD", limitedKey, headScore, gid)
            end
          end
        else
          -- Recover to waiting state
          redis.call("ZADD", gZ, jobScore, jobId)
          redis.call("HSET", jobKey, "status", "waiting")
          
          local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
          if head and #head >= 2 then
            local headScore = tonumber(head[2])
            -- [LIMITED GROUP SET] Check group capacity after stalled recovery
            if isGroupAtCapacity(ns, gid) then
              -- Group is still full, add to limited instead of ready
              redis.call("ZREM", readyKey, gid)
              redis.call("ZADD", limitedKey, headScore, gid)
            else
              -- Group has capacity, add to ready
              redis.call("ZREM", limitedKey, gid)
              redis.call("ZADD", readyKey, headScore, gid)
            end
          end
        end
        -- [FIX] Remove from active list to prevent ghost concurrency
        redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
        redis.call("DEL", ns .. ":lock:" .. gid)
        redis.call("DEL", procKey)
        redis.call("ZREM", processingKey, jobId)
      end
    end
  end
  
  -- Refresh groups after recovery (only if we didn't have any before)
  if not groups or #groups == 0 then
    groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")
  end
end

if not groups or #groups == 0 then
  return nil
end

local chosenGid = nil
local chosenIndex = nil
local headJobId = nil
local job = nil

-- Try to atomically acquire a group and its head job
-- BullMQ-style: use per-group active list instead of group locks
-- Process up to scanLimit groups, but continue scanning if we encounter full groups
local processedCount = 0
local maxProcessed = scanLimit * 2  -- Process up to 2x scanLimit groups to handle full ones

for i = 1, #groups, 2 do
  if processedCount >= maxProcessed then
    break  -- Safety: don't process too many groups in one call
  end
  
  local gid = groups[i]
  local gZ = ns .. ":g:" .. gid
  local groupActiveKey = ns .. ":g:" .. gid .. ":active"
  local configKey = ns .. ":config:" .. gid
  
  -- [PHASE 2 MODIFICATION START]
  -- Check concurrency limit
  local activeCount = redis.call("LLEN", groupActiveKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

  -- [LAZY CLEANUP START: Clean up ghost tasks from active list]
  -- Only trigger cleanup when activeCount >= limit to avoid performance impact on happy path
  if activeCount >= limit then
    local ghostCount = detectGhostTasks(ns, gid, processingKey)
    if ghostCount > 0 then
      -- Remove all ghost tasks from active list
      local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
      for _, jobId in ipairs(activeJobs) do
        local score = redis.call("ZSCORE", processingKey, jobId)
        if not score then
          redis.call("LREM", groupActiveKey, 0, jobId)
        end
      end
      activeCount = math.max(0, activeCount - ghostCount)
    end
  end
  -- [LAZY CLEANUP END]

  if activeCount < limit then
    -- Group has capacity, try to get head job
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local candidateJobId = head[1]
      local headJobKey = ns .. ":job:" .. candidateJobId
      
      -- Pop the job and push to active list atomically
      local zpop = redis.call("ZPOPMIN", gZ, 1)
      if zpop and #zpop > 0 then
        headJobId = zpop[1]
          -- Read the popped job (use headJobId to avoid races)
          headJobKey = ns .. ":job:" .. headJobId
          job = redis.call("HMGET", headJobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
          
          -- Push to group active list
          redis.call("LPUSH", groupActiveKey, headJobId)
          
          chosenGid = gid
          chosenIndex = (i + 1) / 2 - 1
          -- Mark job as processing for accurate stalled detection and idempotency
          redis.call("HSET", headJobKey, "status", "processing")
          break
        end
      end
  else
    -- Group is full, move to limited if it has waiting tasks


    -- [LIMITED GROUP SET]
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      if redis.call("ZCARD", gZ) > 0 then
        redis.call("ZREM", readyKey, gid)
        redis.call("ZADD", limitedKey, headScore, gid)
      end
    end
  end
  -- [PHASE 2 MODIFICATION END]
  
  processedCount = processedCount + 1
end

if not chosenGid or not job then
  return nil
end

local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9]

-- Validate job data exists (handle corrupted/missing job hash)
if not id or id == false then
  -- Job hash is missing/corrupted, clean up group active list
  local groupActiveKey = ns .. ":g:" .. chosenGid .. ":active"
  redis.call("LREM", groupActiveKey, 1, headJobId)
  
  -- Re-add next job to ready queue if exists
  local gZ = ns .. ":g:" .. chosenGid
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    redis.call("ZADD", readyKey, nextScore, chosenGid)
  end
  
  return nil
end

-- Remove the group from ready queue
redis.call("ZREMRANGEBYRANK", readyKey, chosenIndex, chosenIndex)

local procKey = ns .. ":processing:" .. id
local deadline = now + vt
redis.call("HSET", procKey, 
  "groupId", chosenGid, 
  "deadlineAt", tostring(deadline),
  "token", token)

local processingKey2 = ns .. ":processing"
redis.call("ZADD", processingKey2, deadline, id)

-- [LIMITED GROUP SET] Update ready/limited status
local gZ = ns .. ":g:" .. chosenGid
local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
if nextHead and #nextHead >= 2 then
  local nextScore = tonumber(nextHead[2])
  if not isGroupAtCapacity(ns, chosenGid) then
    redis.call("ZADD", readyKey, nextScore, chosenGid)
  else
    redis.call("ZADD", limitedKey, nextScore, chosenGid)
  end
end


local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]
return id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. token


