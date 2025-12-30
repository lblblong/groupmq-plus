--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- Flow relationship module: Remove child from parent
-- Purpose: Handle removal of a child task from its parent, including flow completion logic
--
-- Function: removeChildFromParent(ns, parentId, childId)
-- Parameters:
--   ns: namespace (string)
--   parentId: parent task ID (string)
--   childId: child task ID to remove (string)
-- Returns:
--   boolean: true if parent needs to be promoted (all children resolved)

local function removeChildFromParent(ns, parentId, childId)
  local parentKey = ns .. ":job:" .. parentId
  local parentChildrenKey = ns .. ":flow:children:" .. parentId
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  -- Remove child from parent's children set
  local removedFromSet = redis.call("SREM", parentChildrenKey, childId)
  if removedFromSet ~= 1 then
    return false  -- Child was not in parent's children set
  end

  -- Clean up any recorded child result on parent (avoid stale childrenValues entries)
  redis.call("HDEL", ns .. ":flow:results:" .. parentId, childId)

  -- Decrement the flowRemaining counter
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

  -- If all children are resolved, promote parent to waiting state
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      -- Promote parent to waiting status
      redis.call("HSET", parentKey, "status", "waiting")

      -- Add parent back to its group's waiting queue
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      if parentGroupId then
        local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
        if not parentScore then
          parentScore = tonumber(redis.call("TIME")[1]) * 1000
        end

        local pGZ = ns .. ":g:" .. parentGroupId
        redis.call("ZADD", pGZ, parentScore, parentId)
        redis.call("SADD", ns .. ":groups", parentGroupId)

        -- Update parent group's ready/limited state
        local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
        if pHead and #pHead >= 2 then
          local pHeadScore = tonumber(pHead[2])
          updateGroupReadyLimitedState(ns, parentGroupId, readyKey, limitedKey, pHeadScore)
        end
      end

      return true
    end
  end

  return false
end
