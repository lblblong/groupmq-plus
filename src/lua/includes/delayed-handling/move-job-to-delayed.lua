--[[
  Move a job to the delayed set.

  When a job needs to be delayed (e.g., retry with backoff), it's removed
  from the group's job set and placed in the delayed set, keyed by when
  it should be promoted back to the group.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID to delay
    groupId: The group this job belongs to
    delayUntil: Timestamp (in milliseconds) when the job should be promoted
    jobKey: Redis key for the job (optional optimization)

  Side effects:
    - Adds job to delayed set
    - Updates job status to "delayed"
    - Sets job's delayUntil and runAt fields

  Returns: nothing (void)
]]
local function moveJobToDelayed(ns, jobId, groupId, delayUntil, jobKey)
  jobKey = jobKey or (ns .. ":job:" .. jobId)
  local delayedKey = ns .. ":delayed"

  -- Add to delayed set (score is when it should be promoted)
  redis.call("ZADD", delayedKey, delayUntil, jobId)

  -- Mark job as delayed with the delay time
  redis.call("HSET", jobKey,
    "status", "delayed",
    "delayUntil", tostring(delayUntil),
    "runAt", tostring(delayUntil)
  )
end
