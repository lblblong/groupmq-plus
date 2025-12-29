--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/delayed-handling/promote-delayed-job-complete"

-- argv: ns, now
local ns = KEYS[1]
local now = tonumber(ARGV[1])

local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

local promotedCount = 0

-- Get jobs that are ready (score <= now)
local readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now)

for i = 1, #readyJobs do
  local jobId = readyJobs[i]

  -- Promote each job using the standard function
  local result = promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)

  if result == "promoted" then
    promotedCount = promotedCount + 1
  end
end

return promotedCount


