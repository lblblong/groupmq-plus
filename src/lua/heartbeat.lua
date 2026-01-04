--- @include "includes/security/verify-token"
--- @include "includes/lock/extend-lock"

-- argv: ns, jobId, groupId, extendMs, token
local ns = KEYS[1]
local jobId = ARGV[1]
local gid = ARGV[2]
local extendMs = tonumber(ARGV[3])
local token = ARGV[4] -- [NEW]

-- BullMQ-style: only extend processing deadline, no group lock
local procKey = ns .. ":processing:" .. jobId

-- [NEW] Token verification using shared module
local tokenStatus = verifyToken({ ns = ns, jobId = jobId, token = token })

if tokenStatus == 1 then
  -- Token valid, extend deadline
  local now = tonumber(redis.call("TIME")[1]) * 1000
  local newDeadline = now + extendMs
  redis.call("HSET", procKey, "deadlineAt", tostring(newDeadline))
  
  -- Also update the processing ZSET score
  local processingKey = ns .. ":processing"
  redis.call("ZADD", processingKey, newDeadline, jobId)
  
  -- [BullMQ 风格] 续期独立锁 Key
  -- 这是保持任务活跃的关键：只要心跳正常，锁就不会过期
  extendLock({
    ns = ns,
    jobId = jobId,
    token = token,
    ttlMs = extendMs
  })
  
  return 1
else
  -- Token mismatch (0) or key missing (-1), both indicate stalled
  return 0
end

