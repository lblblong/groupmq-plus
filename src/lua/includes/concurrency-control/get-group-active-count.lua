--[[
  Get the current number of active tasks in a group

  Parameters:
    opts.ns: Redis namespace prefix
    opts.groupId: The group ID

  Returns: Number of active tasks
]]
local function getGroupActiveCount(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LLEN", activeKey)
end
