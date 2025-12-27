-- Atomic reserve operation that checks lock/limit and reserves in one operation
-- argv: ns, nowEpochMs, vtMs, targetGroupId, allowedJobId (optional)
local ns = KEYS[1]
local now = tonumber(ARGV[1])
local vt = tonumber(ARGV[2])
local targetGroupId = ARGV[3]
local allowedJobId = ARGV[4] -- If provided, allow reserve if matches active job (chaining)

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local gZ = ns .. ":g:" .. targetGroupId
local groupActiveKey = ns .. ":g:" .. targetGroupId .. ":active"
local configKey = ns .. ":config:" .. targetGroupId

-- Respect paused state
if redis.call("GET", ns .. ":paused") then
  return nil
end

-- [PHASE 2 MODIFICATION START]
-- Fetch concurrency limit (default 1)
local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
local activeCount = redis.call("LLEN", groupActiveKey)

-- Logic: Can we reserve?
local canReserve = false

if activeCount < limit then
  -- Case 1: Slots available
  canReserve = true
elseif allowedJobId then
  -- Case 2: Group is full, BUT we are explicitly allowed to chain from a specific job
  -- Check if allowedJobId is actually in the active list (reclaiming its own slot)
  -- Note: We scan the list. Since limits are usually small (e.g., <100), this O(N) is acceptable.
  -- For strict O(1), we would need a Set, but List is used for queuing order.
  local items = redis.call("LRANGE", groupActiveKey, 0, -1)
  for _, id in ipairs(items) do
    if id == allowedJobId then
      canReserve = true
      break
    end
  end
end

if not canReserve then
  -- Group is full and no special access granted
  -- [LIMITED GROUP SET] Move group to limited if it has waiting tasks
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])
    -- Check if group has any waiting tasks
    if redis.call("ZCARD", gZ) > 0 then
      -- Move to limited instead of ready
      redis.call("ZREM", readyKey, targetGroupId)
      redis.call("ZADD", limitedKey, headScore, targetGroupId)
    end
  end
  -- [PHASE 2 MODIFICATION] 返回明确的 E_LIMIT 标识（并发已满）
  return "E_LIMIT"
end
-- [PHASE 2 MODIFICATION END]

-- Try to get a job from the group
local head = redis.call("ZRANGE", gZ, 0, 0)
if not head or #head == 0 then
  return nil
end
local headJobId = head[1]
local jobKey = ns .. ":job:" .. headJobId

-- Skip if head job is delayed
local jobStatus = redis.call("HGET", jobKey, "status")
if jobStatus == "delayed" then
  return nil
end

-- Pop the job
local zpop = redis.call("ZPOPMIN", gZ, 1)
if not zpop or #zpop == 0 then
  return nil
end
headJobId = zpop[1]

local job = redis.call("HMGET", jobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

if not id or id == false then
  -- Corruption handling
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    redis.call("ZADD", readyKey, nextScore, targetGroupId)
  end
  return nil
end

-- [PHASE 2 MODIFICATION START]
-- Push to group active list
-- If we are chaining (allowedJobId matched), we should technically verify we aren't adding a duplicate
-- if the previous one wasn't removed yet. But typically complete-with-metadata removes the old one.
-- Just strictly push.
redis.call("LPUSH", groupActiveKey, id)
-- [PHASE 2 MODIFICATION END]

local procKey = ns .. ":processing:" .. id
local deadline = now + vt
redis.call("HSET", procKey, "groupId", groupId, "deadlineAt", tostring(deadline))

local processingKey = ns .. ":processing"
redis.call("ZADD", processingKey, deadline, id)

redis.call("HSET", jobKey, "status", "processing")

local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
if nextHead and #nextHead >= 2 then
  local nextScore = tonumber(nextHead[2])
  redis.call("ZADD", readyKey, nextScore, groupId)
end

return id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0")
