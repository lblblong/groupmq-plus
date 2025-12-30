-- Group state module: Remove job from active list
-- Purpose: Safely remove a job from the group's active job list
-- Handles both normal case (head of list) and race conditions (job elsewhere in list)
--
-- Function: removeJobFromActive(ns, groupId, jobId)
-- Parameters:
--   ns: namespace (string)
--   groupId: group ID (string)
--   jobId: job ID to remove (string)

local function removeJobFromActive(ns, groupId, jobId)
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

  -- Get the head of the active list
  local headJobId = redis.call("LINDEX", groupActiveKey, 0)

  if headJobId == jobId then
    -- Normal case: job is at the head of the active list
    redis.call("LPOP", groupActiveKey)
  else
    -- Race condition: job not at head, but still remove to prevent stale entries
    -- This can happen if another worker already processed and removed it,
    -- or if the job was processed out of order
    redis.call("LREM", groupActiveKey, 1, jobId)
  end
end
