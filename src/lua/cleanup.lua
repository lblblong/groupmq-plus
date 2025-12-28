-- argv: ns, nowEpochMs
local ns = KEYS[1]
local now = tonumber(ARGV[1])

local readyKey = ns .. ":ready"
local processingKey = ns .. ":processing"
local cleaned = 0

local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
for _, jobId in ipairs(expiredJobs) do
  -- CRITICAL: Verify job is STILL in processing to avoid race conditions
  -- If job was completed between our snapshot and now, don't re-add it
  local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)
  
  if stillInProcessing then
    local procKey = ns .. ":processing:" .. jobId
    local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
    local gid = procData[1]
    local deadlineAt = tonumber(procData[2])
    if gid and deadlineAt and now > deadlineAt then
      local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
      local jobScore = tonumber(jobData[1])
      local delayUntil = tonumber(jobData[2]) or 0
      
      if jobScore then
        local gZ = ns .. ":g:" .. gid
        if delayUntil > now then
          -- Recover to delayed state
          redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
          redis.call("HSET", jobKey, "status", "delayed")
          -- [PHYSICAL SEPARATION] Ensure it's NOT in gZ
          redis.call("ZREM", gZ, jobId)
        else
          -- Recover to waiting state
          redis.call("ZADD", gZ, jobScore, jobId)
          redis.call("HSET", jobKey, "status", "waiting")
          
          local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
          if head and #head >= 2 then
            local headScore = tonumber(head[2])
            -- [LIMITED GROUP SET] Check group capacity after recovery
            local groupActiveKey = ns .. ":g:" .. gid .. ":active"
            local configKey = ns .. ":config:" .. gid
            local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
            local currentActive = redis.call("LLEN", groupActiveKey)
            
            if currentActive >= limit then
              redis.call("ZREM", readyKey, gid)
              redis.call("ZADD", ns .. ":limited", headScore, gid)
            else
              redis.call("ZREM", ns .. ":limited", gid)
              redis.call("ZADD", readyKey, headScore, gid)
            end
          end
        end
        redis.call("DEL", ns .. ":lock:" .. gid)
        redis.call("DEL", procKey)
        redis.call("ZREM", processingKey, jobId)
        
        cleaned = cleaned + 1
      end

    end
  end
  -- If not still in processing, it was completed - don't re-add it!
end

return cleaned


