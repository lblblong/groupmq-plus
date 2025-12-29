--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/delayed-handling/promote-delayed-job-complete"

-- argv: ns, now
local ns = KEYS[1]
local now = tonumber(ARGV[1])

local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Find one job that is due now
local ids = redis.call("ZRANGEBYSCORE", delayedKey, 0, now, "LIMIT", 0, 1)
if not ids or #ids == 0 then
  return 0
end

local jobId = ids[1]

-- Promote the job using the standard function
-- (This function includes ZREM of the delayedKey internally)
local result = promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)

-- Convert result to numeric return value
if result == "promoted" then
  return 1
elseif result == "not-found" then
  return 0
else
  return 1 -- treat other cases as moved
end


