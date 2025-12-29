--[[
  Promote a job from the delayed set back to the group's waiting set.

  This is called when the delay time has expired and the job is ready to be processed.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID to promote
    groupId: The group this job belongs to
    jobScore: The sort key for this job in the group
    jobKey: Redis key for the job (optional)
    delayedKey: Redis key for delayed set (optional)

  Side effects:
    - Removes job from delayed set
    - Adds job to group's job set with original score
    - Updates job status to "waiting"
    - Clears delayUntil field

  Returns: nothing (void)
]]
local function promoteJobFromDelayed(ns, jobId, groupId, jobScore, jobKey, delayedKey)
  jobKey = jobKey or (ns .. ":job:" .. jobId)
  delayedKey = delayedKey or (ns .. ":delayed")
  local gZ = ns .. ":g:" .. groupId

  -- Remove from delayed set
  redis.call("ZREM", delayedKey, jobId)

  -- Add back to group's job set
  redis.call("ZADD", gZ, jobScore, jobId)

  -- Update job status back to waiting
  redis.call("HSET", jobKey, "status", "waiting")
  redis.call("HDEL", jobKey, "delayUntil", "runAt")
end
