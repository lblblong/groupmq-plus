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
local parentGroupConfig = ARGV[7] -- [新增] Parent 组配置

local baseEpoch = 1704067200000
local parentKey = ns .. ":job:" .. parentId
local uniqueKey = ns .. ":unique:" .. parentId
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Check idempotence for parent
if redis.call("EXISTS", uniqueKey) == 1 then
  return nil -- Already exists
end
redis.call("SET", uniqueKey, parentId)

-- [新增] 更新 Parent 组配置
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

-- 计算 Children 数量 (总参数减去 Parent 的 7 个参数，除以每个 Child 的 7 个参数)
local childrenCount = (#ARGV - 7) / 7

-- 1. Setup Parent Job
-- Status is 'waiting-children', NOT 'waiting'. It is NOT added to ready queue yet.
local parentRelativeMs = parentOrderMs - baseEpoch
local parentDaysSinceEpoch = math.floor(parentOrderMs / 86400000)
local parentSeqKey = ns .. ":seq:" .. parentDaysSinceEpoch
local parentSeq = redis.call("INCR", parentSeqKey)
local parentScore = parentRelativeMs * 1000 + parentSeq

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

-- 2. Setup Children Jobs
local results = {}

for i = 0, childrenCount - 1 do
  local offset = 7 + (i * 7) -- 偏移量从 7 开始，步长 7
  local childId = ARGV[offset + 1]
  local childGroupId = ARGV[offset + 2]
  local childData = ARGV[offset + 3]
  local childMaxAttempts = ARGV[offset + 4]
  local childOrderMs = tonumber(ARGV[offset + 5])
  local childDelay = tonumber(ARGV[offset + 6])
  local childGroupConfig = ARGV[offset + 7] -- [新增] Child 组配置
  
  -- [新增] 更新 Child 组配置
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

  local childKey = ns .. ":job:" .. childId
  
  -- Generate score (replicate enqueue.lua logic)
  local relativeMs = childOrderMs - baseEpoch
  local daysSinceEpoch = math.floor(childOrderMs / 86400000)
  local seqKey = ns .. ":seq:" .. daysSinceEpoch
  local seq = redis.call("INCR", seqKey)
  local score = relativeMs * 1000 + seq

  -- Create Child Hash
  redis.call("HMSET", childKey,
    "id", childId,
    "groupId", childGroupId,
    "parentId", parentId, -- The link to parent
    "data", childData,
    "attempts", "0",
    "maxAttempts", childMaxAttempts,
    "timestamp", tostring(now),
    "orderMs", tostring(childOrderMs),
    "score", tostring(score),
    "seq", tostring(seq),
    "status", "waiting"
  )
  
  redis.call("SET", ns .. ":unique:" .. childId, childId)
  
  -- Record child relationship for introspection
  -- Key: {ns}:flow:children:{parentId}
  redis.call("SADD", ns .. ":flow:children:" .. parentId, childId)
  
  -- Handle delay or immediate waiting
  if childDelay > 0 then
    local delayUntil = now + childDelay
    redis.call("HSET", childKey, "delayUntil", tostring(delayUntil), "status", "delayed")
    redis.call("ZADD", ns .. ":delayed", delayUntil, childId)
  else
    -- Add to group ZSET
    local gZ = ns .. ":g:" .. childGroupId
    redis.call("ZADD", gZ, score, childId)
    
    -- Update ready queue if this is the new head
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      local groupActiveKey = ns .. ":g:" .. childGroupId .. ":active"
      local configKey = ns .. ":config:" .. childGroupId
      local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
      local currentActive = redis.call("LLEN", groupActiveKey)
      
      -- [LIMITED GROUP SET] Check group capacity
      if currentActive >= limit then
        -- Child group is full, add to limited
        redis.call("ZREM", readyKey, childGroupId)
        redis.call("ZADD", limitedKey, headScore, childGroupId)
      else
        -- Child group has capacity, add to ready
        redis.call("ZREM", limitedKey, childGroupId)
        redis.call("ZADD", readyKey, headScore, childGroupId)
      end
    end
  end
  
  table.insert(results, childId)
end

return results