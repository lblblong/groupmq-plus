-- Group lifecycle module: Clean up empty groups
-- Purpose: Check if a group is empty and clean up its metadata if so
-- If group is not empty, removes it from ready/limited queues for later re-evaluation
--
-- Parameters:
--   ns: namespace (string)
--   groupId: group ID to check and potentially clean up (string)
--
-- Returns:
--   string: "cleaned" if group was completely cleaned up, "not-empty" if group still has jobs

local function cleanupIfGroupEmpty(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local groupBufferKey = ns .. ":buffer:" .. groupId

  -- Get the remaining job count from metadata
  local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0

  -- Get the actual job count in the sorted set
  local jobCount = redis.call("ZCARD", gZ)

  -- If no jobs left in any state, clean up the group completely
  if jobCount == 0 and remainingJobs <= 0 then
    -- Delete all group-related keys
    redis.call("DEL", gZ)
    redis.call("DEL", groupActiveKey)
    redis.call("DEL", groupMetaKey)
    redis.call("DEL", groupBufferKey)

    -- Remove from group sets and queues
    redis.call("SREM", ns .. ":groups", groupId)
    redis.call("ZREM", ns .. ":ready", groupId)
    redis.call("ZREM", ns .. ":limited", groupId)
    redis.call("ZREM", ns .. ":buffering", groupId)

    return "cleaned"
  else
    -- Group still has jobs (in delayed or other states)
    -- Remove from ready/limited queues for later re-evaluation
    redis.call("ZREM", ns .. ":ready", groupId)
    redis.call("ZREM", ns .. ":limited", groupId)

    return "not-empty"
  end
end

return cleanupIfGroupEmpty
