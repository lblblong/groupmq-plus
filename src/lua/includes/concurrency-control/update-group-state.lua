--[[
  Update group's ready/limited status based on capacity.

  This function should be called after any operation that changes the
  number of active tasks or the job count in a group. It ensures the
  group is in the correct queue (ready if there's capacity, limited if full).

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID
    readyKey: Redis key for the ready queue
    limitedKey: Redis key for the limited queue

  Side effects:
    - Moves group between ready and limited sets
    - Updates the group's score if needed

  Returns: nothing (void)
]]
--- @include "includes/concurrency-control/get-group-concurrency-limit"
--- @include "includes/concurrency-control/get-group-active-count"

local function updateGroupState(ns, groupId, readyKey, limitedKey)
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")

  -- If group has no waiting jobs, remove from both ready and limited
  if not head or #head < 2 then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
    return
  end

  local headScore = tonumber(head[2])
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)

  if activeCount >= limit then
    -- Group is at capacity, move to limited
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZADD", limitedKey, headScore, groupId)
  else
    -- Group has capacity, move to ready
    redis.call("ZREM", limitedKey, groupId)
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end
