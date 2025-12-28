-- Complete a job by removing from processing and unlocking the group
-- Does NOT record job metadata - that's handled separately by record-job-result.lua
-- argv: ns, jobId, groupId
local ns = KEYS[1]
local jobId = ARGV[1]
local gid = ARGV[2]

-- Remove from processing
redis.call("DEL", ns .. ":processing:" .. jobId)
redis.call("ZREM", ns .. ":processing", jobId)

-- [FIX] Always remove from active list to prevent ghost concurrency
local groupActiveKey = ns .. ":g:" .. gid .. ":active"
redis.call("LREM", groupActiveKey, 1, jobId)

-- Check if this job holds the lock
local lockKey = ns .. ":lock:" .. gid
local val = redis.call("GET", lockKey)
if val == jobId then
  redis.call("DEL", lockKey)
  
  -- [PHYSICAL SEPARATION] Decrement group job count
  local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
  local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

  -- Check if there are more jobs in this group
  local gZ = ns .. ":g:" .. gid
  local jobCount = redis.call("ZCARD", gZ)
  if jobCount == 0 then
    -- Clean up empty group ONLY if no jobs left in any state
    if remainingJobs <= 0 then
      redis.call("DEL", gZ)
      redis.call("DEL", groupMetaKey)
      redis.call("SREM", ns .. ":groups", gid)
      redis.call("ZREM", ns .. ":ready", gid)
      redis.call("DEL", ns .. ":buffer:" .. gid)
      redis.call("ZREM", ns .. ":buffering", gid)
    else
      -- Group still has delayed/staged jobs, just remove from ready
      redis.call("ZREM", ns .. ":ready", gid)
    end
  else

    -- Group has more jobs, re-add to ready set
    -- Note: If the group was buffering, it will be handled by the buffering logic
    -- If it's not buffering, add to ready immediately
    local groupBufferKey = ns .. ":buffer:" .. gid
    local isBuffering = redis.call("EXISTS", groupBufferKey)
    
    if isBuffering == 0 then
      -- Not buffering, add to ready immediately
      local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if nextHead and #nextHead >= 2 then
        local nextScore = tonumber(nextHead[2])
        local readyKey = ns .. ":ready"
        redis.call("ZADD", readyKey, nextScore, gid)
      end
    end
    -- If buffering, the scheduler will promote when ready
  end
  
  return 1
end
return 0
