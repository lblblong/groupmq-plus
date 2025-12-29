--[[
  Get all standard Redis keys for a specific job.

  Useful for debugging and cleanup operations.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID
    groupId: The group ID (optional but recommended)

  Returns: Table with all relevant keys:
    {
      jobHash = key for job data hash,
      processingLock = key for processing metadata,
      uniqueId = key for unique constraint
    }
]]
--- @include "includes/key-helpers/make-job-key"
--- @include "includes/key-helpers/make-processing-key"
--- @include "includes/key-helpers/make-unique-key"
--- @include "includes/key-helpers/make-group-key"
--- @include "includes/key-helpers/make-active-list-key"

local function getJobKeys(ns, jobId, groupId)
  return {
    jobHash = makeJobKey(ns, jobId),
    processingLock = makeProcessingKey(ns, jobId),
    uniqueId = makeUniqueKey(ns, jobId),
    groupKey = groupId and makeGroupKey(ns, groupId) or nil,
    activeListKey = groupId and makeActiveListKey(ns, groupId) or nil
  }
end
