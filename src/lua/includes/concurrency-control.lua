--[[
  Concurrency Control & Group State Management

  This module handles the group concurrency limit enforcement and
  the ready/limited state transitions based on group capacity.

  Used by: reserve.lua, reserve-atomic.lua, reserve-batch.lua,
           retry.lua, dead-letter.lua, and other state-management scripts
]]

--[[
  Get the concurrency limit for a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Concurrency limit (default 1 if not configured)
]]
local function getGroupConcurrencyLimit(ns, groupId)
  local configKey = ns .. ":config:" .. groupId
  return tonumber(redis.call("HGET", configKey, "concurrency")) or 1
end

--[[
  Get the current number of active tasks in a group

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Number of active tasks
]]
local function getGroupActiveCount(ns, groupId)
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  return redis.call("LLEN", activeKey)
end

--[[
  Check if a group has reached its concurrency capacity

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: true if group is at or over capacity, false otherwise
]]
local function isGroupAtCapacity(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return activeCount >= limit
end

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

--[[
  Simple check for group capacity without updating state.
  Used as a quick check before more expensive operations.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: The number of available slots (0 or negative if full)
]]
local function getAvailableSlots(ns, groupId)
  local limit = getGroupConcurrencyLimit(ns, groupId)
  local activeCount = getGroupActiveCount(ns, groupId)
  return math.max(0, limit - activeCount)
end
