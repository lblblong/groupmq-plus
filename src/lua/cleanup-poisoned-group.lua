--- @include "includes/group-analysis/analyze-group-poisoning"

-- argv: ns, groupId, now
local ns = KEYS[1]
local groupId = ARGV[1]
local now = tonumber(ARGV[2])

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local gZ = ns .. ":g:" .. groupId
local lockKey = ns .. ":lock:" .. groupId

-- Check if group has any jobs at all
local jobCount = redis.call("ZCARD", gZ)
if jobCount == 0 then
  redis.call("ZREM", readyKey, groupId)
  return "empty"
end

-- Check if group is currently locked by another worker
local lockValue = redis.call("GET", lockKey)
if lockValue then
  local lockTtl = redis.call("PTTL", lockKey)
  if lockTtl > 0 then
    return "locked"
  end
end

-- Check if group is poisoned using centralized analysis module
local isPoisoned = analyzeGroupPoisoning(ns, groupId)
if isPoisoned then
  redis.call("ZREM", readyKey, groupId)
  redis.call("ZREM", limitedKey, groupId)
  return "poisoned"
end

return "ok"


