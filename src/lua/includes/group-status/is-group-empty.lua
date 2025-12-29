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
