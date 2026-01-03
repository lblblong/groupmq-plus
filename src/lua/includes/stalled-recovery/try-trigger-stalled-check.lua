--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Stalled recovery module: Trigger stalled check with throttling
-- Purpose: Encapsulate stalled job check frequency control and recovery logic
--
-- Function: tryTriggerStalledCheck(opts)
-- Parameters:
--   opts.ns: namespace (string)
--   opts.now: current timestamp in ms (number)
--   opts.vt: visibility timeout in ms (number)
--   opts.readyKey: ready queue key (string)
--   opts.limitedKey: limited queue key (string)
--   opts.processingKey: processing key (string)
-- Returns:
--   boolean: true if stalled check was performed, false if throttled

local function tryTriggerStalledCheck(opts)
  local ns = opts.ns
  local now = opts.now
  local vt = opts.vt
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey
  local processingKey = opts.processingKey
  local stalledCheckKey = ns .. ":stalled:lastcheck"
  local lastCheck = tonumber(redis.call("GET", stalledCheckKey)) or 0

  -- Adaptive check interval: 1/4 of jobTimeout (to check 4x during visibility window), max 5s
  local stalledCheckInterval = math.min(math.floor(vt / 4), 5000)

  local shouldCheckStalled = (now - lastCheck) >= stalledCheckInterval

  if not shouldCheckStalled then
    return false
  end

  redis.call("SET", stalledCheckKey, tostring(now))

  -- Perform stalled job recovery inline
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
            updateGroupReadyLimitedState({ ns = ns, groupId = gid, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
          end
        end
        -- Remove from active list to prevent ghost concurrency
        redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
        redis.call("DEL", procKey)
        redis.call("ZREM", processingKey, jobId)
      end
    end
  end

  return true
end
