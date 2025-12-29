--[[
  Get the concurrency limit for a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Concurrency limit (default 1 if not configured)
]]
local function getGroupConcurrencyLimit(ns, groupId)
  local configKey = ns .. ":config:" .. groupId
  return tonumber(redis.call("HGET", configKey, "concurrency")) or 1
end
