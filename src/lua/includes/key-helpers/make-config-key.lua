--[[
  Construct a group configuration hash key.

  The group config hash stores configuration like concurrency limit.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:config:group1")
]]
local function makeConfigKey(ns, groupId)
  return ns .. ":config:" .. groupId
end
