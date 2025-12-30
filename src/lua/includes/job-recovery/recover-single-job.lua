--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Job recovery module: Recover a single job from processing
-- Purpose: Handle recovery of a timeout or stalled job to waiting or delayed state
--
-- Function: recoverSingleJob(ns, jobId, groupId, jobScore, delayUntil, now, readyKey, limitedKey, processingKey)
-- Parameters:
--   ns: namespace (string)
--   jobId: job ID (string)
--   groupId: group ID (string)
--   jobScore: job score (number)
--   delayUntil: delay deadline (number, 0 if not delayed)
--   now: current timestamp in ms (number)
--   readyKey: ready queue key (string)
--   limitedKey: limited queue key (string)
--   processingKey: processing key (string)
-- Returns:
--   string: "recovered" or "delayed"

local function recoverSingleJob(ns, jobId, groupId, jobScore, delayUntil, now, readyKey, limitedKey, processingKey)
  local jobKey = ns .. ":job:" .. jobId
  local procKey = ns .. ":processing:" .. jobId
  local gZ = ns .. ":g:" .. groupId

  -- Clean up processing state
  redis.call("LREM", ns .. ":g:" .. groupId .. ":active", 1, jobId)
  redis.call("DEL", ns .. ":lock:" .. groupId)
  redis.call("DEL", procKey)
  redis.call("ZREM", processingKey, jobId)

  -- Determine recovery target
  if delayUntil > 0 and delayUntil > now then
    -- Job should be delayed
    redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
    redis.call("HSET", jobKey, "status", "delayed")
    -- [PHYSICAL SEPARATION] Ensure it's NOT in group ZSET
    redis.call("ZREM", gZ, jobId)
    return "delayed"
  else
    -- Job should be recovered to waiting state
    redis.call("ZADD", gZ, jobScore, jobId)
    redis.call("HSET", jobKey, "status", "waiting")

    -- Update group ready/limited state
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
    end

    return "recovered"
  end
end
