--[[
  Simple check for group capacity without updating state.
  Used as a quick check before more expensive operations.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: The number of available slots (0 or negative if full)
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function getAvailableSlots(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return math.max(0, limit - activeCount)
end
