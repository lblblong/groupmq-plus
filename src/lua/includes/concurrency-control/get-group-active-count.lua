--[[
  Get the current number of active tasks in a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of active tasks
]]
local function getGroupActiveCount(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LLEN", activeKey)
end
