--- @include "includes/job-lifecycle/store-job"
--- @include "includes/group-state/add-job-to-group"

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
if parentGroupConfig and parentGroupConfig ~= "" and parentGroupConfig ~= "null" then
  local status, config = pcall(cjson.decode, parentGroupConfig)
  if status and config then
    local configKey = ns .. ":config:" .. parentGroupId
    local args = {}
    for k, v in pairs(config) do
      if v ~= nil then
        table.insert(args, k)
        table.insert(args, tostring(v))
      end
    end
    if #args > 0 then
      redis.call("HMSET", configKey, unpack(args))
    end
  end
end

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
  if childGroupConfig and childGroupConfig ~= "" and childGroupConfig ~= "null" then
    local status, config = pcall(cjson.decode, childGroupConfig)
    if status and config then
      local configKey = ns .. ":config:" .. childGroupId
      local args = {}
      for k, v in pairs(config) do
        if v ~= nil then
          table.insert(args, k)
          table.insert(args, tostring(v))
        end
      end
      if #args > 0 then
        redis.call("HMSET", configKey, unpack(args))
      end
    end
  end

  -- Store child job using storeJob module
  local childKey = ns .. ":job:" .. childId
  local childDelayUntil = childDelay > 0 and (now + childDelay) or 0

  local storeOpts = {
    maxAttempts = tonumber(childMaxAttempts),
    orderMs = childOrderMs,
    delayUntil = childDelayUntil,
    clientTimestamp = now
  }
  local result = storeJob(ns, childId, childGroupId, childData, storeOpts)
  local childScore = result[1]

  -- Add parent ID link to child
  redis.call("HSET", childKey, "parentId", parentId)

  -- Record child relationship
  redis.call("SADD", ns .. ":flow:children:" .. parentId, childId)

  -- Route child to appropriate queue (using addJobToGroup with 0 orderingDelayMs)
  local childStatus = addJobToGroup(ns, childGroupId, childId, childScore, childDelayUntil, childOrderMs, 0)

  table.insert(results, childId)
end

return results