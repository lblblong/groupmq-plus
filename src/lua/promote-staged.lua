-- Promote staged jobs that are now ready to be processed
-- argv: ns, now, limit
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2]) or 100

local stageKey = ns .. ":stage"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local timerKey = ns .. ":stage:timer"

local promotedCount = 0

-- Get jobs that are ready (score <= now)
local readyJobs = redis.call("ZRANGEBYSCORE", stageKey, 0, now, "LIMIT", 0, limit)

for i = 1, #readyJobs do
  local jobId = readyJobs[i]
  local jobKey = ns .. ":job:" .. jobId
  
  -- Get job metadata
  local jobData = redis.call("HMGET", jobKey, "groupId", "score", "status")
  local groupId = jobData[1]
  local score = jobData[2]
  local status = jobData[3]
  
  if groupId and score and status == "staged" then
    local gZ = ns .. ":g:" .. groupId
    
    -- Remove from staging set
    redis.call("ZREM", stageKey, jobId)
    
    -- Add to group ZSET with original score
    redis.call("ZADD", gZ, tonumber(score), jobId)
    redis.call("SADD", ns .. ":groups", groupId)
    
    -- Update job status from "staged" to "waiting"
    redis.call("HSET", jobKey, "status", "waiting")
    
    -- Check if group should be added to ready queue
    -- Add group to ready if the head job is now waiting (not delayed or staged)
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headJobId = head[1]
      local headScore = tonumber(head[2])
      local headJobKey = ns .. ":job:" .. headJobId
      local headStatus = redis.call("HGET", headJobKey, "status")
      
      -- [LIMITED GROUP SET] Check if head job is waiting and evaluate capacity
      if headStatus == "waiting" then
        local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
        local configKey = ns .. ":config:" .. groupId
        local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
        local currentActive = redis.call("LLEN", groupActiveKey)
        
        if currentActive >= limit then
          -- Group is full, move to limited
          redis.call("ZREM", readyKey, groupId)
          redis.call("ZADD", limitedKey, headScore, groupId)
        else
          -- Group has slots, move to ready
          redis.call("ZREM", limitedKey, groupId)
          redis.call("ZADD", readyKey, headScore, groupId)
        end
      end
    end
    
    promotedCount = promotedCount + 1
  end
end

-- Recompute timer: set to the next earliest staged job
local nextHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
if nextHead and #nextHead >= 2 then
  local nextReleaseAt = tonumber(nextHead[2])
  -- Set timer to expire when the next earliest job is ready
  local ttlMs = math.max(1, nextReleaseAt - now)
  redis.call("SET", timerKey, "1", "PX", ttlMs)
else
  -- No more staged jobs, delete the timer
  redis.call("DEL", timerKey)
end

return promotedCount

