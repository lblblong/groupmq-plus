--[[
  Check if a specific job is in a group's active list.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    jobId: The job ID to check

  Returns: true if job is in active list, false otherwise
]]
local function isJobActive(ns, groupId, jobId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  local items = redis.call("LRANGE", activeKey, 0, -1)
  for _, id in ipairs(items) do
    if id == jobId then
      return true
    end
  end
  return false
end
