--[[
  Construct a job's unique/idempotence key.

  Used to prevent duplicate execution of jobs with the same unique ID.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: Redis key (e.g., "myns:unique:job-123")
]]
local function makeUniqueKey(ns, jobId)
  return ns .. ":unique:" .. jobId
end
