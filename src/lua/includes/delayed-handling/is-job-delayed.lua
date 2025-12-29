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
