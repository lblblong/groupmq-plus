--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/stalled-recovery/recover-stalled-jobs-complete"

-- Check for stalled jobs and move them back to waiting or fail them
-- KEYS: namespace, currentTime, gracePeriod, maxStalledCount
-- Returns: array of [jobId, groupId, action] for each stalled job found
--   action: "recovered" or "failed"

local ns = KEYS[1]
local now = tonumber(ARGV[1])
local gracePeriod = tonumber(ARGV[2]) or 0
local maxStalledCount = tonumber(ARGV[3]) or 1

-- Circuit breaker for high concurrency: limit stalled job recovery
local circuitBreakerKey = ns .. ":stalled:circuit"
local lastCheck = redis.call("GET", circuitBreakerKey)
if lastCheck then
  local lastCheckTime = tonumber(lastCheck)
  local circuitBreakerInterval = 2000
  if lastCheckTime and (now - lastCheckTime) < circuitBreakerInterval then
    return {}
  end
end
redis.call("SET", circuitBreakerKey, now, "PX", 3000)

local processingKey = ns .. ":processing"
local groupsKey = ns .. ":groups"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Call the stalled recovery function
local results = recoverStalledJobsCompletely({
  ns = ns,
  now = now,
  gracePeriod = gracePeriod,
  maxStalledCount = maxStalledCount,
  readyKey = readyKey,
  limitedKey = limitedKey
})

return results

