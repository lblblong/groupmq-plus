--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Flow module: Update parent flow when child task completes
-- Purpose: Track child completion results and promote parent to waiting when all children are done
--
-- Parameters:
--   ns: namespace (string)
--   parentId: parent job ID (string)
--   childId: child job ID that completed (string)
--   status: status of the completed child task (string, e.g., "completed", "failed")
--   resultOrError: result or error data from the child (string)
--   timestamp: completion timestamp (number)
--   readyKey: key for ready queue (string)
--   limitedKey: key for limited queue (string)
--
-- Returns:
--   nil (no specific return value)

local function updateParentFlow(ns, parentId, childId, status, resultOrError, timestamp, readyKey, limitedKey)
  local parentKey = ns .. ":job:" .. parentId

  -- 1. Store child result in flow results hash
  -- Key: flow:results:{parentId}, Field: {childId}
  local flowResultsKey = ns .. ":flow:results:" .. parentId

  -- Wrap result as {status, data} structure for better flow tracking
  local flowEntry = cjson.encode({
    status = status,
    data = resultOrError
  })
  redis.call("HSET", flowResultsKey, childId, flowEntry)

  -- 2. Decrement the remaining children counter
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

  -- 3. If all children are done, move parent to waiting state
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      -- Update parent status to waiting
      redis.call("HSET", parentKey, "status", "waiting")

      -- Add parent to its group and ready queue
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))

      -- Use current time if score not set
      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end

      -- Add parent job to its group's sorted set
      local pGZ = ns .. ":g:" .. parentGroupId
      redis.call("ZADD", pGZ, parentScore, parentId)
      redis.call("SADD", ns .. ":groups", parentGroupId)

      -- Update parent group status (ready/limited) based on group capacity
      local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
      if pHead and #pHead >= 2 then
        local pHeadScore = tonumber(pHead[2])
        -- Use head score to represent the earliest task in the group
        updateGroupReadyLimitedState(ns, parentGroupId, readyKey, limitedKey, pHeadScore)
      end
    end
  end
end

return updateParentFlow
