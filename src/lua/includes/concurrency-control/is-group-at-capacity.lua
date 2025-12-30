--[[
  Check if a group has reached its concurrency capacity

  Parameters:
    opts.ns: Redis namespace prefix
    opts.groupId: The group ID

  Returns: true if group is at or over capacity, false otherwise
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function isGroupAtCapacity(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local limit = getGroupConcurrencyLimit({ ns = ns, groupId = groupId })
  local activeCount = getGroupActiveCount({ ns = ns, groupId = groupId })
  return activeCount >= limit
end
