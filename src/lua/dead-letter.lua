-- argv: ns, jobId, groupId
local ns = KEYS[1]
local jobId = ARGV[1]
local groupId = ARGV[2]
local gZ = ns .. ":g:" .. groupId
local readyKey = ns .. ":ready"

local jobKey = ns .. ":job:" .. jobId

-- [FLOW SUPPORT: Get parentId before any cleanup]
local parentId = redis.call("HGET", jobKey, "parentId")

-- Remove job from group
redis.call("ZREM", gZ, jobId)

-- Remove from processing if it's there
redis.call("DEL", ns .. ":processing:" .. jobId)
redis.call("ZREM", ns .. ":processing", jobId)

-- No counter operations - use ZCARD for counts

-- Remove idempotence mapping to allow reuse
redis.call("DEL", ns .. ":unique:" .. jobId)

-- BullMQ-style: Remove from group active list if present
local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)

-- Check if group is now empty or should be removed from ready queue
local jobCount = redis.call("ZCARD", gZ)
if jobCount == 0 then
  -- Group is empty, remove from ready queue and clean up
  redis.call("ZREM", readyKey, groupId)
  redis.call("DEL", gZ)
  redis.call("DEL", groupActiveKey)
  redis.call("SREM", ns .. ":groups", groupId)
else
  -- Group still has jobs, update ready queue with new head
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end

-- Optionally store in dead letter queue (uncomment if needed)
-- redis.call("LPUSH", ns .. ":dead", jobId)

-- [FLOW SUPPORT: Update parent if this job is a child in a flow]
if parentId then
  local parentKey = ns .. ":job:" .. parentId
  -- 1. Store error result in flow:results hash
  local flowResultsKey = ns .. ":flow:results:" .. parentId
  -- [NEW] 核心变更：统一死信的存储格式
  local flowEntry = cjson.encode({
    status = "failed",
    data = '{"error":"dead-lettered", "reason":"max attempts exceeded"}'
  })
  redis.call("HSET", flowResultsKey, jobId, flowEntry)
  
  -- 2. Decrement remaining counter
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)
  
  -- 3. If all children done, move parent to waiting
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      redis.call("HSET", parentKey, "status", "waiting")
      
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end
      
      local pGZ = ns .. ":g:" .. parentGroupId
      redis.call("ZADD", pGZ, parentScore, parentId)
      redis.call("SADD", ns .. ":groups", parentGroupId)
      
      -- Add to ready if head
      local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
      if pHead and #pHead >= 2 then
         local pHeadScore = tonumber(pHead[2])
         redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
      end
    end
  end
end

return 1

