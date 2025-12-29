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
