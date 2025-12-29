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
