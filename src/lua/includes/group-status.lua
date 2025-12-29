--[[
  Group Status & State Queries

  This module provides utility functions for querying group state information
  such as job counts, status, and group composition.

  These functions are useful for diagnostics, monitoring, and internal state checks.
]]

--[[
  Get the total number of waiting jobs in a group.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of jobs in the group's job set
]]
local function getGroupJobCount(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  return redis.call("ZCARD", gZ)
end

--[[
  Check if a group has any waiting jobs.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: true if group is empty (no waiting jobs), false otherwise
]]
local function isGroupEmpty(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local count = redis.call("ZCARD", gZ)
  return count == 0
end

--[[
  Get the head (first) job in a group's job set.

  The head job is the next one that would be processed/reserved.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Job ID if group has jobs, nil otherwise
]]
local function getGroupHeadJob(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0)
  if head and #head > 0 then
    return head[1]
  end
  return nil
end

--[[
  Get the head job with its score.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Array [jobId, score] if group has jobs, nil otherwise
]]
local function getGroupHeadJobWithScore(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    return {head[1], tonumber(head[2])}
  end
  return nil
end

--[[
  Get the total number of active tasks in a group (being processed).

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of active tasks
]]
local function getGroupActiveTaskCount(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LLEN", activeKey)
end

--[[
  Check if a specific job is in a group's active list.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    jobId: The job ID to check

  Returns: true if job is in active list, false otherwise
]]
local function isJobActive(ns, groupId, jobId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  local items = redis.call("LRANGE", activeKey, 0, -1)
  for _, id in ipairs(items) do
    if id == jobId then
      return true
    end
  end
  return false
end

--[[
  Get all active job IDs in a group.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Array of active job IDs
]]
local function getGroupActiveJobs(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LRANGE", activeKey, 0, -1)
end

--[[
  Get the total number of delayed jobs for a group.

  Note: This requires iterating through the delayed set, which is not per-group.
  This is an O(N) operation in the worst case.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of delayed jobs belonging to this group
]]
local function getGroupDelayedCount(ns, groupId)
  local delayedKey = ns .. ":delayed"
  local allDelayed = redis.call("ZRANGE", delayedKey, 0, -1)
  local count = 0

  for _, jobId in ipairs(allDelayed) do
    local jobKey = ns .. ":job:" .. jobId
    local gid = redis.call("HGET", jobKey, "groupId")
    if gid == groupId then
      count = count + 1
    end
  end

  return count
end

--[[
  Get the complete status snapshot for a group.

  This is useful for debugging and monitoring.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Table with group status information:
    {
      waitingCount: number of waiting jobs,
      activeCount: number of active tasks,
      delayedCount: number of delayed jobs,
      isEmpty: whether group has no jobs,
      headJobId: ID of next job to process (if any),
      isReady: whether group is in ready queue,
      isLimited: whether group is in limited queue
    }
]]
local function getGroupStatus(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  local waitingCount = redis.call("ZCARD", gZ)
  local activeCount = redis.call("LLEN", activeKey)
  local headJob = redis.call("ZRANGE", gZ, 0, 0)
  local headJobId = (headJob and #headJob > 0) and headJob[1] or nil

  local isReady = redis.call("ZSCORE", readyKey, groupId) ~= nil and redis.call("ZSCORE", readyKey, groupId) ~= false
  local isLimited = redis.call("ZSCORE", limitedKey, groupId) ~= nil and redis.call("ZSCORE", limitedKey, groupId) ~= false

  return {
    waitingCount = waitingCount,
    activeCount = activeCount,
    isEmpty = waitingCount == 0,
    headJobId = headJobId,
    isReady = isReady,
    isLimited = isLimited
  }
end
