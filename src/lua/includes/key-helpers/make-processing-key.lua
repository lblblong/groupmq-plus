--[[
  Construct a job's processing lock hash key.

  This stores metadata about a job being processed, including the token and deadline.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: Redis key (e.g., "myns:processing:job-123")
]]
local function makeProcessingKey(ns, jobId)
  return ns .. ":processing:" .. jobId
end
