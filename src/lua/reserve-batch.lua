--- @include "includes/common/is-queue-paused"
--- @include "includes/ghost-cleanup/detect-ghost-tasks"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/stalled-recovery/try-trigger-stalled-check"

-- argv: ns, nowEpochMs, vtMs, maxBatch, tokenBase
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local maxBatch = tonumber(ARGV[3]) or 16
local tokenBase = ARGV[4]

local readyKey = ns .. ":ready"
local processingKey = ns .. ":processing"
local limitedKey = ns .. ":limited"

-- Early exit if paused
if isQueuePaused(ns) then
  return {}
end

local out = {}

-- Try to trigger stalled check (throttled)
tryTriggerStalledCheck(ns, now, vt, readyKey, limitedKey, processingKey)

-- Pop up to maxBatch groups from ready set (lowest score first)
local groups = redis.call("ZRANGE", readyKey, 0, maxBatch - 1, "WITHSCORES")
if not groups or #groups == 0 then
  return {}
end

local processedGroups = {}
-- BullMQ-style: use per-group active list instead of group locks
for i = 1, #groups, 2 do
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
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headJobId = head[1]
      local headScore = tonumber(head[2])
      local headJobKey = ns .. ":job:" .. headJobId
      
      -- Pop the job and push to active list atomically
      local zpop = redis.call("ZPOPMIN", gZ, 1)
      if zpop and #zpop > 0 then
          local jobId = zpop[1]
          
          local jobKey = ns .. ":job:" .. jobId
          local job = redis.call("HMGET", jobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
          local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

          -- Validate job data exists (handle corrupted/missing job hash)
          if not id or id == false then
            -- Job hash is missing/corrupted, skip this job and continue
            -- Re-add next job to ready queue if exists
            local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if nextHead and #nextHead >= 2 then
              local nextScore = tonumber(nextHead[2])
              redis.call("ZADD", readyKey, nextScore, gid)
            end
          else
            -- Generate unique token for this job using base + index
            local token = tokenBase .. "-" .. i
            
            -- Push to group active list
            redis.call("LPUSH", groupActiveKey, jobId)
            
            -- Mark job as processing
            redis.call("HSET", jobKey, "status", "processing")
            
            local procKey = ns .. ":processing:" .. id
            local deadline = now + vt
            redis.call("HSET", procKey, 
              "groupId", gid, 
              "deadlineAt", tostring(deadline),
              "token", token)
            redis.call("ZADD", processingKey, deadline, id)

            -- [LIMITED GROUP SET] Update ready/limited status
            local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if nextHead and #nextHead >= 2 then
              local nextScore = tonumber(nextHead[2])
              updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, nextScore)
            end


            table.insert(out, id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. token)
            table.insert(processedGroups, gid)
          end
        end
      end
  else
    -- Group is full, move to limited if it has waiting tasks

    -- [LIMITED GROUP SET]
    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
      local nextScore = tonumber(nextHead[2])
      updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, nextScore)
    end
  end
  -- [PHASE 2 MODIFICATION END]
  -- Note: Groups with active jobs will be skipped
end

-- Remove only the groups that were actually processed from ready queue
for _, gid in ipairs(processedGroups) do
  redis.call("ZREM", readyKey, gid)
end

return out


