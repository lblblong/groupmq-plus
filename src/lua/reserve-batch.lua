--- @include "includes/common/is-queue-paused"
--- @include "includes/common/format-job-response"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/stalled-recovery/try-trigger-stalled-check"
--- @include "includes/concurrency-control/try-pop-next-job"

-- argv: ns, nowEpochMs, vtMs, maxBatch, tokenBase
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local maxBatch = tonumber(ARGV[3]) or 16
local tokenBase = ARGV[4]

local readyKey = ns .. ":ready"
local processingKey = ns .. ":processing"
local limitedKey = ns .. ":limited"

-- Early exit if paused
if isQueuePaused({ ns = ns }) then
  return {}
end

local out = {}

-- Try to trigger stalled check (throttled)
tryTriggerStalledCheck({ ns = ns, now = now, vt = vt, readyKey = readyKey, limitedKey = limitedKey, processingKey = processingKey })

-- Pop up to maxBatch groups from ready set (lowest score first)
local groups = redis.call("ZRANGE", readyKey, 0, maxBatch - 1, "WITHSCORES")
if not groups or #groups == 0 then
  return {}
end

local processedGroups = {}
local jobIndex = 0  -- Counter for generating unique tokens

-- BullMQ-style: use per-group active list instead of group locks
for i = 1, #groups, 2 do
  local gid = groups[i]
  local gZ = ns .. ":g:" .. gid

  -- Try to pop the next job from this group with batch-specific token
  local token = tokenBase .. "-" .. jobIndex
  local result = tryPopNextJob({
    ns = ns,
    groupId = gid,
    vt = vt,
    token = token,
    now = now,
    processingKey = processingKey
  })

  if result then
    -- Successfully got a job, record it for later removal
    table.insert(processedGroups, gid)

    -- Update ready/limited status for next job in group
    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
      local nextScore = tonumber(nextHead[2])
      updateGroupReadyLimitedState({ ns = ns, groupId = gid, readyKey = readyKey, limitedKey = limitedKey, headScore = nextScore })
    end

    -- Add job to batch results
    result.token = token  -- Override with batch-specific token
    table.insert(out, formatJobResponse(result))

    jobIndex = jobIndex + 1
  else
    -- Group doesn't have capacity or has no jobs, check if need to move to limited
    local configKey = ns .. ":config:" .. gid
    local activeCount = redis.call("LLEN", ns .. ":g:" .. gid .. ":active")
    local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

    if activeCount >= limit then
      -- Group is at capacity, move to limited if it has waiting tasks
      local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if head and #head >= 2 then
        local headScore = tonumber(head[2])
        if redis.call("ZCARD", gZ) > 0 then
          updateGroupReadyLimitedState({ ns = ns, groupId = gid, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
        end
      end
    end
  end
end

-- Remove only the groups that were actually processed from ready queue
for _, gid in ipairs(processedGroups) do
  redis.call("ZREM", readyKey, gid)
end

return out


