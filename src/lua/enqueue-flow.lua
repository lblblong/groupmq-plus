--- @include "includes/job-lifecycle/store-job"
--- @include "includes/group-state/add-job-to-group"
--- @include "includes/group-state/update-group-config"

-- Atomic Flow Creation
-- KEYS: [ns]
-- ARGV: [parentId, parentGroupId, parentData, parentMaxAttempts, parentOrderMs, now, parentGroupConfig, ...childrenArgs]
-- childrenArgs: [id, groupId, data, maxAttempts, orderMs, delay, groupConfig, ...] (7 fields per child)

local ns = KEYS[1]
local parentId = ARGV[1]
local parentGroupId = ARGV[2]
local parentData = ARGV[3]
local parentMaxAttempts = ARGV[4]
local parentOrderMs = tonumber(ARGV[5])
local now = tonumber(ARGV[6])
local parentGroupConfig = ARGV[7]

local parentKey = ns .. ":job:" .. parentId
local uniqueKey = ns .. ":unique:" .. parentId

-- Check idempotence for parent
if redis.call("EXISTS", uniqueKey) == 1 then
  return nil
end
redis.call("SET", uniqueKey, parentId)

-- Update Parent group config
updateGroupConfig({
  ns = ns,
  groupId = parentGroupId,
  configJson = parentGroupConfig
})

-- Calculate children count
local childrenCount = (#ARGV - 7) / 7

-- Step 1: Setup Parent Job using storeJob module
local baseEpoch = 1704067200000
local parentRelativeMs = parentOrderMs - baseEpoch
local parentDaysSinceEpoch = math.floor(parentOrderMs / 86400000)
local parentSeqKey = ns .. ":seq:" .. parentDaysSinceEpoch
local parentSeq = redis.call("INCR", parentSeqKey)
local parentScore = parentRelativeMs * 1000 + parentSeq

-- Store parent with special "waiting-children" status
redis.call("HMSET", parentKey,
  "id", parentId,
  "groupId", parentGroupId,
  "data", parentData,
  "attempts", "0",
  "maxAttempts", parentMaxAttempts,
  "timestamp", tostring(now),
  "orderMs", tostring(parentOrderMs),
  "score", tostring(parentScore),
  "seq", tostring(parentSeq),
  "status", "waiting-children",
  "flowRemaining", tostring(childrenCount),
  "isFlowParent", "1"
)
redis.call("SADD", ns .. ":groups", parentGroupId)
redis.call("HINCRBY", ns .. ":g:" .. parentGroupId .. ":meta", "count", 1)

-- Step 2: Setup Children Jobs
local results = {}

for i = 0, childrenCount - 1 do
  local offset = 7 + (i * 7)
  local childId = ARGV[offset + 1]
  local childGroupId = ARGV[offset + 2]
  local childData = ARGV[offset + 3]
  local childMaxAttempts = ARGV[offset + 4]
  local childOrderMs = tonumber(ARGV[offset + 5])
  local childDelay = tonumber(ARGV[offset + 6])
  local childGroupConfig = ARGV[offset + 7]

  -- Update Child group config
  updateGroupConfig({
    ns = ns,
    groupId = childGroupId,
    configJson = childGroupConfig
  })

  -- Store child job using storeJob module
  local childKey = ns .. ":job:" .. childId
  local childDelayUntil = childDelay > 0 and (now + childDelay) or 0

  local result = storeJob({
    ns = ns,
    jobId = childId,
    groupId = childGroupId,
    data = childData,
    maxAttempts = tonumber(childMaxAttempts),
    orderMs = childOrderMs,
    delayUntil = childDelayUntil,
    clientTimestamp = now
  })
  local childScore = result[1]

  -- Add parent ID link to child
  redis.call("HSET", childKey, "parentId", parentId)

  -- Record child relationship
  redis.call("SADD", ns .. ":flow:children:" .. parentId, childId)

  -- Route child to appropriate queue (using addJobToGroup with 0 orderingDelayMs)
  local childStatus = addJobToGroup({
    ns = ns,
    groupId = childGroupId,
    jobId = childId,
    score = childScore,
    delayUntil = childDelayUntil,
    orderMs = childOrderMs,
    orderingDelayMs = 0
  })

  table.insert(results, childId)
end

return results