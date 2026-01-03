--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Job recovery module: Recover a single job from processing
-- Purpose: Handle recovery of a timeout or stalled job to waiting or delayed state
--
-- Function: recoverSingleJob(opts)
-- Parameters:
--   opts.ns: namespace (string)
--   opts.jobId: job ID (string)
--   opts.groupId: group ID (string)
--   opts.jobScore: job score (number)
--   opts.delayUntil: delay deadline (number, 0 if not delayed)
--   opts.now: current timestamp in ms (number)
--   opts.readyKey: ready queue key (string)
--   opts.limitedKey: limited queue key (string)
--   opts.processingKey: processing key (string)
-- Returns:
--   string: "recovered" or "delayed"

local function recoverSingleJob(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local groupId = opts.groupId
  local jobScore = opts.jobScore
  local delayUntil = opts.delayUntil
  local now = opts.now
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey
  local processingKey = opts.processingKey
  local jobKey = ns .. ":job:" .. jobId
  local procKey = ns .. ":processing:" .. jobId
  local gZ = ns .. ":g:" .. groupId

  -- Clean up processing state
  redis.call("LREM", ns .. ":g:" .. groupId .. ":active", 1, jobId)
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
      updateGroupReadyLimitedState({ ns = ns, groupId = groupId, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
    end

    return "recovered"
  end
end
