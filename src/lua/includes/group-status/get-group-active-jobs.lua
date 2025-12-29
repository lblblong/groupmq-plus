--[[
  Get all active job IDs in a group.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Array of active job IDs
]]
local function getGroupActiveJobs(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LRANGE", activeKey, 0, -1)
end
