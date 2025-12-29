--[[
  Check if a job has an active processing lock (i.e., is currently being processed).

  A job has an active lock if there's a processing key with a token.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: true if job has an active lock, false otherwise
]]
local function hasActiveLock(ns, jobId)
  local procKey = ns .. ":processing:" .. jobId
  local token = redis.call("HGET", procKey, "token")
  return token ~= nil and token ~= false
end
