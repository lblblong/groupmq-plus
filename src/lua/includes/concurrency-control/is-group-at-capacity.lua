--[[
  Check if a group has reached its concurrency capacity

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: true if group is at or over capacity, false otherwise
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return activeCount >= limit
end
