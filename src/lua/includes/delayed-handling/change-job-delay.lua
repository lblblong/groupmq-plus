--[[
  Change the delay time for a delayed job.

  This is used when a job's delay needs to be adjusted after it's been scheduled.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID to adjust
    newDelayUntil: New delay time (in milliseconds)
    jobKey: Redis key for the job (optional)

  Side effects:
    - Updates job's score in delayed set
    - Updates job's delayUntil field

  Returns: nothing (void)
]]
local function changeJobDelay(ns, jobId, newDelayUntil, jobKey)
  jobKey = jobKey or (ns .. ":job:" .. jobId)
  local delayedKey = ns .. ":delayed"

  -- Update the score in delayed set
  redis.call("ZADD", delayedKey, newDelayUntil, jobId)

  -- Update the job's delay fields
  redis.call("HSET", jobKey,
    "delayUntil", tostring(newDelayUntil),
    "runAt", tostring(newDelayUntil)
  )
end
