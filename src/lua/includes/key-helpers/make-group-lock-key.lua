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
