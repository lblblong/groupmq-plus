--[[
  Handle moving a full group to limited set if it has waiting tasks

  Parameters:
    opts.ns: Redis namespace prefix
    opts.groupId: The group ID to check
    opts.readyKey: The ready set key
    opts.limitedKey: The limited set key
]]
local function handleFullGroup(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey

  local configKey = ns .. ":config:" .. groupId
  local activeKey = ns .. ":g:" .. groupId .. ":active"
  local gZ = ns .. ":g:" .. groupId

  -- Get active count and limit
  local activeCount = redis.call("LLEN", activeKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

  -- Check if group is at capacity
  if activeCount >= limit then
    -- Get group head with score
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      -- Only move to limited if group has waiting tasks
      if redis.call("ZCARD", gZ) > 0 then
        updateGroupReadyLimitedState({ ns = ns, groupId = groupId, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
      end
    end
  end
end
