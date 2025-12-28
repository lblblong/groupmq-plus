-- argv: ns, jobId
local ns = KEYS[1]
local jobId = ARGV[1]

local jobKey = ns .. ":job:" .. jobId
local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local processingKey = ns .. ":processing"

-- If job does not exist, return 0
if redis.call("EXISTS", jobKey) == 0 then
  return 0
end

local jobData = redis.call("HMGET", jobKey, "groupId", "parentId", "status")
local groupId = jobData[1]
local parentId = jobData[2]
local status = jobData[3]

-- Remove from delayed and processing structures
redis.call("ZREM", delayedKey, jobId)
redis.call("DEL", ns .. ":processing:" .. jobId)
redis.call("ZREM", processingKey, jobId)

-- Remove from completed/failed retention sets if present
redis.call("ZREM", ns .. ":completed", jobId)
redis.call("ZREM", ns .. ":failed", jobId)

-- Delete idempotence mapping
redis.call("DEL", ns .. ":unique:" .. jobId)

-- If we have a group, update group zset and ready queue accordingly
if groupId then
  local gZ = ns .. ":g:" .. groupId
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
  redis.call("ZREM", gZ, jobId)
  
  -- [FIX] Remove from active list to prevent ghost concurrency
  redis.call("LREM", groupActiveKey, 1, jobId)

  -- [PHYSICAL SEPARATION] Decrement group job count ONLY if it was in an active state
  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0
  
  if status ~= "completed" and status ~= "failed" then
    remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
  end

  if remainingJobs <= 0 then

    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
    -- Clean up empty group
    redis.call("DEL", gZ)
    redis.call("DEL", groupActiveKey)
    redis.call("DEL", groupMetaKey)
    redis.call("SREM", ns .. ":groups", groupId)
  else
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      local configKey = ns .. ":config:" .. groupId
      local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
      local currentActive = redis.call("LLEN", groupActiveKey)
      
      -- [LIMITED GROUP SET] Check group's current queue position and update accordingly
      if currentActive >= limit then
        -- Group is still full, keep it in limited (or add to limited)
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZADD", limitedKey, headScore, groupId)
      else
        -- Group has capacity now, move to ready
        redis.call("ZREM", limitedKey, groupId)
        redis.call("ZADD", readyKey, headScore, groupId)
      end
    end
  end
end

-- Finally, delete the job hash, flow results and children tracking (variadic DEL optimization)
redis.call("DEL", 
  jobKey,
  ns .. ":flow:results:" .. jobId,
  ns .. ":flow:children:" .. jobId
)

-- Clean up flow relationships
-- If this job is a child, remove it from parent's children set
if parentId then
  local parentKey = ns .. ":job:" .. parentId
  local parentChildrenKey = ns .. ":flow:children:" .. parentId

  -- Only act if we actually removed membership (idempotent / avoids double-decrement)
  local removedFromSet = redis.call("SREM", parentChildrenKey, jobId)
  if removedFromSet == 1 then
    -- Also remove any recorded child result on parent (avoid stale childrenValues entries)
    redis.call("HDEL", ns .. ":flow:results:" .. parentId, jobId)

    -- Decrement remaining counter
    local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

    -- If all children are resolved, move parent to waiting and enqueue it
    if remaining <= 0 then
      local parentStatus = redis.call("HGET", parentKey, "status")
      if parentStatus == "waiting-children" then
        redis.call("HSET", parentKey, "status", "waiting")

        local parentGroupId = redis.call("HGET", parentKey, "groupId")
        if parentGroupId then
          local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
          if not parentScore then
            parentScore = tonumber(redis.call("TIME")[1]) * 1000
          end

          local pGZ = ns .. ":g:" .. parentGroupId
          redis.call("ZADD", pGZ, parentScore, parentId)
          redis.call("SADD", ns .. ":groups", parentGroupId)

          -- Update ready/limited based on head score + concurrency
          local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
          if pHead and #pHead >= 2 then
            local pHeadScore = tonumber(pHead[2])
            local pGroupActiveKey = ns .. ":g:" .. parentGroupId .. ":active"
            local pConfigKey = ns .. ":config:" .. parentGroupId
            local pLimit = tonumber(redis.call("HGET", pConfigKey, "concurrency")) or 1
            local pCurrentActive = redis.call("LLEN", pGroupActiveKey)

            if pCurrentActive >= pLimit then
              redis.call("ZREM", readyKey, parentGroupId)
              redis.call("ZADD", limitedKey, pHeadScore, parentGroupId)
            else
              redis.call("ZREM", limitedKey, parentGroupId)
              redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
            end
          end
        end
      end
    end
  end
end

return 1


