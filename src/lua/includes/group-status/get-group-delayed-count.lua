--[[
  Get the total number of delayed jobs for a group.

  Note: This requires iterating through the delayed set, which is not per-group.
  This is an O(N) operation in the worst case.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of delayed jobs belonging to this group
]]
local function getGroupDelayedCount(ns, groupId)
  local delayedKey = ns .. ":delayed"
  local allDelayed = redis.call("ZRANGE", delayedKey, 0, -1)
  local count = 0

  for _, jobId in ipairs(allDelayed) do
    local jobKey = ns .. ":job:" .. jobId
    local gid = redis.call("HGET", jobKey, "groupId")
    if gid == groupId then
      count = count + 1
    end
  end

  return count
end
