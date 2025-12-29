--[[
  Convert job data array to a string format suitable for returning from Lua scripts.

  Used to construct the return value for scripts that need to send job data to clients.

  Parameters:
    parsed: Result from parseJobData()
    deadline: The deadline timestamp for this job
    token: The processing token for this reservation
    delimiter: String to use as separator (default: "|||")

  Returns: Formatted string with all job data concatenated
]]
--- @include "includes/job-data/parse-job-data"

local function formatJobDataString(parsed, deadline, token, delimiter)
  delimiter = delimiter or "|||"
  return parsed.id .. delimiter ..
         parsed.groupId .. delimiter ..
         parsed.payload .. delimiter ..
         parsed.attempts .. delimiter ..
         parsed.maxAttempts .. delimiter ..
         parsed.seq .. delimiter ..
         parsed.timestamp .. delimiter ..
         parsed.orderMs .. delimiter ..
         parsed.score .. delimiter ..
         deadline .. delimiter ..
         (parsed.isFlowParent or "0") .. delimiter ..
         token
end
