--[[
  Construct a job data hash key.

  The job hash stores all metadata and data for a specific job.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: Redis key (e.g., "myns:job:job-123")
]]
local function makeJobKey(ns, jobId)
  return ns .. ":job:" .. jobId
end
