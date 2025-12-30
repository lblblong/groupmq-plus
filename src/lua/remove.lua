--- @include "includes/job-lifecycle/delete-job-completely"

-- argv: ns, jobId
local ns = KEYS[1]
local jobId = ARGV[1]

local result = deleteJobCompletely({
  ns = ns,
  jobId = jobId
})

-- Return 1 if deleted, 0 if not found (for compatibility)
return (result == "deleted") and 1 or 0


