--[[
  Clean up ghost tasks from a group's active list.

  Ghost tasks are identified as tasks that exist in the group's active list
  but don't have a corresponding entry in the processing set (ZSET).
  Since the processing set is the authoritative source of truth for
  what jobs are actually being processed, any task not in it is a ghost.

  This cleanup is only triggered when the group is at capacity to avoid
  performance impact on the happy path.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    processingKey: Optional override for processing key (default: ns .. ":processing")

  Side effects:
    - Removes ghost tasks from the group's active list

  Returns: Number of ghost tasks cleaned up
]]
local function cleanupGhostTasks(ns, groupId, processingKey)
  processingKey = processingKey or (ns .. ":processing")
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

  local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
  local prunedCount = 0

  for _, jobId in ipairs(activeJobs) do
    -- Validate against processing ZSET as the authoritative source
    local score = redis.call("ZSCORE", processingKey, jobId)
    if not score then
      -- Found a ghost task - remove it immediately
      redis.call("LREM", groupActiveKey, 0, jobId)
      prunedCount = prunedCount + 1
    end
  end

  return prunedCount
end
