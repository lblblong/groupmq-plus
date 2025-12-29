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
