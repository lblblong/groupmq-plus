--[[
  Check if a group has ghost tasks without cleaning them.
  Useful for debugging and monitoring.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    processingKey: Optional override for processing key

  Returns: Number of ghost tasks detected
]]
local function detectGhostTasks(ns, groupId, processingKey)
  processingKey = processingKey or (ns .. ":processing")
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

  local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
  local ghostCount = 0

  for _, jobId in ipairs(activeJobs) do
    local score = redis.call("ZSCORE", processingKey, jobId)
    if not score then
      ghostCount = ghostCount + 1
    end
  end

  return ghostCount
end
