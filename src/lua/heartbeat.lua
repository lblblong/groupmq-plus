-- argv: ns, jobId, groupId, extendMs, token
local ns = KEYS[1]
local jobId = ARGV[1]
local gid = ARGV[2]
local extendMs = tonumber(ARGV[3])
local token = ARGV[4] -- [NEW]

-- BullMQ-style: only extend processing deadline, no group lock
local procKey = ns .. ":processing:" .. jobId
-- [NEW] Token verification
local storedToken = redis.call("HGET", procKey, "token")

if storedToken and storedToken == token then
  local now = tonumber(redis.call("TIME")[1]) * 1000
  local newDeadline = now + extendMs
  redis.call("HSET", procKey, "deadlineAt", tostring(newDeadline))
  
  -- Also update the processing ZSET score
  local processingKey = ns .. ":processing"
  redis.call("ZADD", processingKey, newDeadline, jobId)
  return 1
else
  -- Token mismatch or key missing (stalled)
  return 0
end

