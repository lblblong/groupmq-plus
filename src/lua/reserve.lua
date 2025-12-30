--- @include "includes/common/is-queue-paused"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/stalled-recovery/try-trigger-stalled-check"
--- @include "includes/concurrency-control/try-pop-next-job"

-- argv: ns, nowEpochMs, vtMs, scanLimit, token
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local scanLimit = tonumber(ARGV[3]) or 20
local token = ARGV[4]

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local processingKey = ns .. ":processing"

-- Respect paused state
if isQueuePaused(ns) then
  return nil
end

-- Get available groups
local groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")

-- Try to trigger stalled check (throttled) and handle recovery
local stalledCheckPerformed = tryTriggerStalledCheck(ns, now, vt, readyKey, limitedKey, processingKey)
if stalledCheckPerformed and (not groups or #groups == 0) then
  -- Refresh groups list if stalled check was performed and list is empty
  groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")
end

if not groups or #groups == 0 then
  return nil
end

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

  -- Try to pop the next job from this group
  local result = tryPopNextJob({
    ns = ns,
    groupId = gid,
    vt = vt,
    token = token,
    now = now,
    processingKey = processingKey
  })

  if result then
    -- Successfully got a job, remove group from ready queue
    local chosenIndex = (i + 1) / 2 - 1
    redis.call("ZREMRANGEBYRANK", readyKey, chosenIndex, chosenIndex)

    -- Update ready/limited status for next job in group
    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
      local nextScore = tonumber(nextHead[2])
      updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, nextScore)
    end

    -- Return job data as formatted string
    return result.jobId .. "|||" .. result.groupId .. "|||" .. result.payload .. "|||" ..
           result.attempts .. "|||" .. result.maxAttempts .. "|||" .. result.seq .. "|||" ..
           result.timestamp .. "|||" .. result.orderMs .. "|||" .. result.score .. "|||" ..
           result.deadline .. "|||" .. result.isFlowParent .. "|||" .. result.token
  else
    -- Group doesn't have capacity or has no jobs, check if need to move to limited
    local configKey = ns .. ":config:" .. gid
    local activeCount = redis.call("LLEN", ns .. ":g:" .. gid .. ":active")
    local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

    if activeCount >= limit then
      -- Group is at capacity, move to limited if it has waiting tasks
      local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if head and #head >= 2 then
        local headScore = tonumber(head[2])
        if redis.call("ZCARD", gZ) > 0 then
          updateGroupReadyLimitedState(ns, gid, readyKey, limitedKey, headScore)
        end
      end
    end
  end

  processedCount = processedCount + 1
end

return nil


