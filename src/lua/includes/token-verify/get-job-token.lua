--[[
  Get the current token for a job (if any).

  This is useful for debugging and monitoring token state.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: The token string if it exists, or nil if none
]]
local function getJobToken(ns, jobId)
  local procKey = ns .. ":processing:" .. jobId
  return redis.call("HGET", procKey, "token")
end
