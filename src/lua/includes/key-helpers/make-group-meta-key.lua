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
