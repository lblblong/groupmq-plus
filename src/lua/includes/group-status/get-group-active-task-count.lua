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
