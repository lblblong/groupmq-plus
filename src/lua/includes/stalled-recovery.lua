--[[
  Stalled Job Recovery Logic

  This module handles the recovery of stalled (timed out) jobs that were
  processing but failed to complete or send a heartbeat within the visibility timeout.

  Used by: reserve.lua, reserve-batch.lua, check-stalled.lua
]]

--[[
  Recover stalled jobs by checking the processing set for expired jobs
  and moving them back to appropriate state (waiting, delayed, or limited).

  Parameters:
    ns: Redis namespace prefix
    now: Current time in milliseconds
    vt: Visibility timeout in milliseconds

  Side effects:
    - Moves expired jobs from processing set to group/delayed/limited sets
    - Updates job status to "waiting" or "delayed"
    - Updates group ready/limited status
    - Cleans up processing locks

  Returns: nothing (void)
]]
local function recoverStalledJobs(ns, now, vt)
  local processingKey = ns .. ":processing"
  local stalledCheckKey = ns .. ":stalled:lastcheck"
  local lastCheck = tonumber(redis.call("GET", stalledCheckKey)) or 0
  local stalledCheckInterval = math.min(math.floor(vt / 4), 5000)

  -- Skip check if too soon to avoid overhead
  if (now - lastCheck) < stalledCheckInterval then
    return
  end

  redis.call("SET", stalledCheckKey, tostring(now))

  -- Find all expired jobs in processing set
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
        local readyKey = ns .. ":ready"
        local limitedKey = ns .. ":limited"

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
            -- Check group capacity after stalled recovery
            local groupActiveKey = ns .. ":g:" .. gid .. ":active"
            local configKey = ns .. ":config:" .. gid
            local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
            local currentActive = redis.call("LLEN", groupActiveKey)

            if currentActive >= limit then
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

        -- Clean up processing lock
        redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
        redis.call("DEL", ns .. ":lock:" .. gid)
        redis.call("DEL", procKey)
        redis.call("ZREM", processingKey, jobId)
      end
    end
  end
end
