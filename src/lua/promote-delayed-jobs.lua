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
  local jobKey = ns .. ":job:" .. jobId
  local groupId = redis.call("HGET", jobKey, "groupId")
  
  if groupId then
    local gZ = ns .. ":g:" .. groupId
    
    -- Remove from delayed set
    redis.call("ZREM", delayedKey, jobId)
    
    -- [PHYSICAL SEPARATION] Add back to group ZSET with original score
    local score = tonumber(redis.call("HGET", jobKey, "score"))
    if score then
      redis.call("ZADD", gZ, score, jobId)
      redis.call("SADD", ns .. ":groups", groupId)
      redis.call("HSET", jobKey, "status", "waiting")
      redis.call("HDEL", jobKey, "delayUntil", "runAt")
      
      -- Check if this job is now the head of its group (earliest in group)
      local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if head and #head >= 2 then
        local headJobId = head[1]
        local headScore = tonumber(head[2])
        
        local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
        local configKey = ns .. ":config:" .. groupId
        local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
        local currentActive = redis.call("LLEN", groupActiveKey)
        
        -- [LIMITED GROUP SET] Check group capacity
        if currentActive >= limit then
          -- Group is full, move to limited
          redis.call("ZREM", readyKey, groupId)
          redis.call("ZADD", limitedKey, headScore, groupId)
        else
          -- Group has slots, move to ready
          redis.call("ZREM", limitedKey, groupId)
          redis.call("ZADD", readyKey, headScore, groupId)
        end
        promotedCount = promotedCount + 1
      end
    end
  end
end

return promotedCount


