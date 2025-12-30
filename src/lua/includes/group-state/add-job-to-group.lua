--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Group state module: Add job to group
-- Purpose: Route job to appropriate queue (Delayed, Stage, or Group Waiting)
-- based on delay and ordering constraints
--
-- Function: addJobToGroup(ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs)
-- Parameters:
--   ns: namespace (string)
--   groupId: group ID (string)
--   jobId: job ID (string)
--   score: job score (number)
--   delayUntil: delay deadline (number, 0 if not delayed)
--   orderMs: ordering timestamp (number)
--   orderingDelayMs: ordering delay in ms (number, 0 if not staged)
-- Returns:
--   string: job status ("delayed", "staged", or "waiting")

local function addJobToGroup(ns, groupId, jobId, score, delayUntil, orderMs, orderingDelayMs)
  local jobKey = ns .. ":job:" .. jobId
  local readyKey = ns .. ":ready"
  local delayedKey = ns .. ":delayed"
  local limitedKey = ns .. ":limited"
  local stageKey = ns .. ":stage"
  local timerKey = ns .. ":stage:timer"
  local gZ = ns .. ":g:" .. groupId

  -- Get current server time
  local timeResult = redis.call("TIME")
  local now = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

  local jobStatus = "waiting"

  -- CASE 1: Job is delayed
  if delayUntil > 0 and delayUntil > now then
    -- Add to delayed set ONLY (physical separation)
    redis.call("ZADD", delayedKey, delayUntil, jobId)
    jobStatus = "delayed"
    redis.call("HSET", jobKey, "status", jobStatus)

  -- CASE 2: Job should be staged for ordering
  elseif orderMs and orderingDelayMs > 0 then
    local releaseAt = orderMs + orderingDelayMs
    redis.call("ZADD", stageKey, releaseAt, jobId)
    jobStatus = "staged"
    redis.call("HSET", jobKey, "status", jobStatus)

    -- Update/set timer to earliest staged job
    local currentHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
    if currentHead and #currentHead >= 2 then
      local headReleaseAt = tonumber(currentHead[2])
      local ttlMs = math.max(1, headReleaseAt - now)
      redis.call("SET", timerKey, "1", "PX", ttlMs)
    end

  -- CASE 3: Job is ready for group processing
  else
    redis.call("ZADD", gZ, score, jobId)
    jobStatus = "waiting"
    redis.call("HSET", jobKey, "status", jobStatus)

    -- Update group's ready/limited state
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
    end
  end

  return jobStatus
end
