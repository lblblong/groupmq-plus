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
--- @include "includes/group-status/get-group-job-count"
--- @include "includes/group-status/get-group-active-task-count"
--- @include "includes/group-status/get-group-head-job"

local function getGroupStatus(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  local waitingCount = getGroupJobCount(ns, groupId)
  local activeCount = getGroupActiveTaskCount(ns, groupId)
  local headJobId = getGroupHeadJob(ns, groupId)

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
