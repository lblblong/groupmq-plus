--- @include "includes/common/is-queue-paused"
--- @include "includes/common/format-job-response"
--- @include "includes/concurrency-control/try-pop-next-job"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/group-state/add-job-to-group"

-- Atomic reserve operation that supports chaining with allowedJobId exemption
-- argv: ns, nowEpochMs, vtMs, targetGroupId, allowedJobId (optional), token
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local targetGroupId = ARGV[3]
local allowedJobId = ARGV[4]  -- If provided, allow reserve if matches active job (chaining)
local token = ARGV[5]

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local gZ = ns .. ":g:" .. targetGroupId

-- Respect paused state
if isQueuePaused({ ns = ns }) then
  return nil
end

-- Try to pop using shared logic with chaining exemption
local result = tryPopNextJob({
  ns = ns,
  groupId = targetGroupId,
  vt = vt,
  token = token,
  now = now,
  processingKey = ns .. ":processing",
  allowedJobId = allowedJobId  -- Pass chaining exemption
})

if result then
  -- Successfully got a job
  -- Update ready/limited status for next job in group
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    updateGroupReadyLimitedState({ ns = ns, groupId = targetGroupId, readyKey = readyKey, limitedKey = limitedKey, headScore = nextScore })
  else
    -- No more jobs in group
    redis.call("ZREM", readyKey, targetGroupId)
    redis.call("ZREM", limitedKey, targetGroupId)
  end

  return formatJobResponse(result)
else
  -- Could not pop (group full or no jobs)
  -- Check if group has waiting tasks to move to limited
  local configKey = ns .. ":config:" .. targetGroupId
  local activeKey = ns .. ":g:" .. targetGroupId .. ":active"
  local activeCount = redis.call("LLEN", activeKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

  if activeCount >= limit then
    -- Group is at capacity, move to limited if it has waiting tasks
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      if redis.call("ZCARD", gZ) > 0 then
        updateGroupReadyLimitedState({ ns = ns, groupId = targetGroupId, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
      end
    end
    return "E_LIMIT"
  end

  return nil
end
