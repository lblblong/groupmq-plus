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
--- @include "includes/delayed-handling/promote-job-from-delayed"

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
