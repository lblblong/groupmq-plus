-- check-idempotency.lua
-- Checks if a job can be enqueued by verifying idempotency
-- Returns: "new" (can enqueue), "exists" (already exists), or "stale" (stale key, cleaned)

local function checkIdempotency(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local keepCompleted = opts.keepCompleted or 0

  local jobKey = ns .. ":job:" .. jobId
  local uniqueKey = ns .. ":unique:" .. jobId

  -- Try to acquire the unique lock for this job
  local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")
  if not uniqueSet then
    -- Duplicate detected. Check for stale unique mapping
    local exists = redis.call("EXISTS", jobKey)
    if exists == 0 then
      -- Job doesn't exist but unique key does (stale), clean up and proceed
      redis.call("DEL", uniqueKey)
      redis.call("SET", uniqueKey, jobId)
      return "stale"
    else
      -- Job exists, check its status and location
      local gid = redis.call("HGET", jobKey, "groupId")
      local inProcessing = redis.call("ZSCORE", ns .. ":processing", jobId)
      local inDelayed = redis.call("ZSCORE", ns .. ":delayed", jobId)
      local inGroup = nil
      if gid then
        inGroup = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
      end

      if (not inProcessing) and (not inDelayed) and (not inGroup) then
        -- Job is not in any queue (completed or deleted)
        if keepCompleted == 0 then
          redis.call("DEL", jobKey)
          redis.call("DEL", uniqueKey)
          redis.call("SET", uniqueKey, jobId)
          return "stale"
        else
          -- Job hash exists and we're keeping completed jobs
          redis.call("SET", uniqueKey, jobId)
          return "exists"
        end
      else
        -- Job is in a queue, need to check its status
        if keepCompleted == 0 then
          local jobStatus = redis.call("HGET", jobKey, "status")
          if jobStatus == "completed" then
            redis.call("DEL", jobKey)
            redis.call("DEL", uniqueKey)
            redis.call("SET", uniqueKey, jobId)
            return "stale"
          else
            -- Job is still active, return exists
            redis.call("SET", uniqueKey, jobId)
            return "exists"
          end
        end

        -- Double-check if job still exists and is active
        local activeAgain = redis.call("ZSCORE", ns .. ":processing", jobId)
        local delayedAgain = redis.call("ZSCORE", ns .. ":delayed", jobId)
        local inGroupAgain = nil
        if gid then
          inGroupAgain = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
        end
        local jobStillExists = redis.call("EXISTS", jobKey)
        if jobStillExists == 1 and (activeAgain or delayedAgain or inGroupAgain) then
          return "exists"
        end
      end
    end
  end

  return "new"
end
