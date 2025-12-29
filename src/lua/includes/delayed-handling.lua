--[[
  Delayed Job Handling

  This module provides utilities for managing delayed jobs - jobs that should
  not be executed until a specified time in the future.

  The system uses physical separation: delayed jobs are stored in a separate
  "delayed" sorted set (by delay time) rather than in the group's job set.
  This keeps the group set clean and focused on waiting/ready jobs.

  Used by: retry.lua, promote-delayed-one.lua, promote-delayed-jobs.lua,
           change-delay.lua, and other delay management scripts
]]

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

--[[
  Promote all jobs from delayed set that are ready (delayUntil <= now).

  This is a bulk operation used by promote-delayed-jobs.lua to process
  all ready delayed jobs at once.

  Parameters:
    ns: Redis namespace prefix
    now: Current time in milliseconds
    maxPromote: Maximum number of jobs to promote (optional, no limit if nil)

  Side effects:
    - Removes promoted jobs from delayed set
    - Adds promoted jobs back to their respective group sets
    - Updates job statuses

  Returns: Array of job IDs that were promoted
]]
local function promoteReadyDelayedJobs(ns, now, maxPromote)
  local delayedKey = ns .. ":delayed"
  local promoted = {}

  -- Find all jobs whose delay has expired
  local readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now)

  -- Limit promotion if requested
  if maxPromote then
    local limit = math.min(maxPromote, #readyJobs)
    readyJobs = {table.unpack(readyJobs, 1, limit)}
  end

  for _, jobId in ipairs(readyJobs) do
    local jobKey = ns .. ":job:" .. jobId
    local jobData = redis.call("HMGET", jobKey, "groupId", "score")
    local groupId = jobData[1]
    local jobScore = tonumber(jobData[2])

    if groupId and jobScore then
      promoteJobFromDelayed(ns, jobId, groupId, jobScore, jobKey, delayedKey)
      table.insert(promoted, jobId)
    end
  end

  return promoted
end

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

--[[
  Check if a job is delayed.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID to check

  Returns: true if job is in delayed set, false otherwise
]]
local function isJobDelayed(ns, jobId)
  local delayedKey = ns .. ":delayed"
  local score = redis.call("ZSCORE", delayedKey, jobId)
  return score ~= nil and score ~= false
end

--[[
  Get the delay time for a delayed job.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: Delay timestamp (milliseconds) if delayed, nil otherwise
]]
local function getJobDelayTime(ns, jobId)
  local delayedKey = ns .. ":delayed"
  local score = redis.call("ZSCORE", delayedKey, jobId)
  if score then
    return tonumber(score)
  end
  return nil
end
