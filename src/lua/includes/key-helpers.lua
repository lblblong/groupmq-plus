--[[
  Redis Key Construction Helpers

  This module provides utility functions for constructing Redis keys consistently
  across all Lua scripts. This ensures a single source of truth for key naming patterns
  and makes refactoring key structure easier in the future.

  All keys follow the pattern: namespace:type:identifier
]]

--[[
  Construct a group's job set key.

  The group job set (zset) stores all waiting jobs for a group, sorted by priority.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:g:group1")
]]
local function makeGroupKey(ns, groupId)
  return ns .. ":g:" .. groupId
end

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

--[[
  Construct a group configuration hash key.

  The group config hash stores configuration like concurrency limit.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:config:group1")
]]
local function makeConfigKey(ns, groupId)
  return ns .. ":config:" .. groupId
end

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

--[[
  Construct a group's active task list key.

  The active list stores job IDs currently being processed in this group (for concurrency control).

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:g:group1:active")
]]
local function makeActiveListKey(ns, groupId)
  return ns .. ":g:" .. groupId .. ":active"
end

--[[
  Construct a group's lock key.

  This is used for per-group locking (legacy support, may be deprecated).

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:lock:group1")
]]
local function makeGroupLockKey(ns, groupId)
  return ns .. ":lock:" .. groupId
end

--[[
  Construct a group's metadata hash key.

  This stores per-group metadata like job count.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:g:group1:meta")
]]
local function makeGroupMetaKey(ns, groupId)
  return ns .. ":g:" .. groupId .. ":meta"
end

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
local function getJobKeys(ns, jobId, groupId)
  return {
    jobHash = makeJobKey(ns, jobId),
    processingLock = makeProcessingKey(ns, jobId),
    uniqueId = makeUniqueKey(ns, jobId),
    groupKey = groupId and makeGroupKey(ns, groupId) or nil,
    activeListKey = groupId and makeActiveListKey(ns, groupId) or nil
  }
end

--[[
  Get all standard Redis keys for a specific group.

  Useful for debugging and cleanup operations.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Table with all relevant keys:
    {
      groupSet = key for group job set,
      configHash = key for group config,
      activeList = key for active tasks,
      lockKey = key for group lock,
      metaHash = key for group metadata
    }
]]
local function getGroupKeys(ns, groupId)
  return {
    groupSet = makeGroupKey(ns, groupId),
    configHash = makeConfigKey(ns, groupId),
    activeList = makeActiveListKey(ns, groupId),
    lockKey = makeGroupLockKey(ns, groupId),
    metaHash = makeGroupMetaKey(ns, groupId)
  }
end
