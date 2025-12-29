--[[
  Construct a group's active task list key.

  The active list stores job IDs currently being processed in this group (for concurrency control).

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Redis key (e.g., "myns:g:group1:active")
]]
local function makeActiveListKey(ns, groupId)
  return ns .. ":g:" .. groupId .. ":active"
end
