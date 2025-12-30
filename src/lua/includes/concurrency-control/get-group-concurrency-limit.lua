--[[
  Get the concurrency limit for a group

  Parameters:
    opts.ns: Redis namespace prefix
    opts.groupId: The group ID

  Returns: Concurrency limit (default 1 if not configured)
]]
local function getGroupConcurrencyLimit(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local configKey = ns .. ":config:" .. groupId
  return tonumber(redis.call("HGET", configKey, "concurrency")) or 1
end
