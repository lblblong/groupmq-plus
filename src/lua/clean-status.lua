-- argv: ns, status, graceAtMs, limit
local ns = KEYS[1]
local status = ARGV[1]
local graceAt = tonumber(ARGV[2]) or 0
local limit = tonumber(ARGV[3]) or 1000

local setKey = nil
if status == 'completed' then
  setKey = ns .. ':completed'
elseif status == 'failed' then
  setKey = ns .. ':failed'
elseif status == 'delayed' then
  setKey = ns .. ':delayed'
else
  -- unsupported status for clean
  return 0
end

-- Fetch up to 'limit' job ids with score <= graceAt
local ids = redis.call('ZRANGEBYSCORE', setKey, '-inf', graceAt, 'LIMIT', 0, limit)

local readyKey = ns .. ':ready'
local limitedKey = ns .. ':limited'

local removed = 0
for i = 1, #ids do
  local id = ids[i]
  local jobKey = ns .. ':job:' .. id

  -- Remove from the primary set first to avoid reprocessing
  redis.call('ZREM', setKey, id)

  -- Remove from group and update ready queue for ALL statuses
  -- This prevents poisoned groups when completed/failed jobs are cleaned
  local groupId = redis.call('HGET', jobKey, 'groupId')
  local parentId = redis.call('HGET', jobKey, 'parentId')
  if groupId then
    local gZ = ns .. ':g:' .. groupId
    redis.call('ZREM', gZ, id)
    local jobCount = redis.call('ZCARD', gZ)
    if jobCount == 0 then
      redis.call('ZREM', readyKey, groupId)
      redis.call('ZREM', limitedKey, groupId)
      -- Clean up empty group
      redis.call('DEL', gZ)
      redis.call('SREM', ns .. ':groups', groupId)
    elseif status == 'delayed' then
      -- Only update ready/limited queue score for delayed jobs
      -- (completed/failed jobs shouldn't affect ready/limited queue)
      local head = redis.call('ZRANGE', gZ, 0, 0, 'WITHSCORES')
      if head and #head >= 2 then
        local headScore = tonumber(head[2])
        -- Update whichever queue the group is in (ready or limited)
        if redis.call('ZSCORE', readyKey, groupId) then
          redis.call('ZADD', readyKey, headScore, groupId)
        elseif redis.call('ZSCORE', limitedKey, groupId) then
          redis.call('ZADD', limitedKey, headScore, groupId)
        end
      end
    end
  end

  -- Delete job hash, idempotence key, flow results and children tracking (variadic DEL optimization)
  redis.call('DEL', 
    jobKey,
    ns .. ':unique:' .. id,
    ns .. ':flow:results:' .. id,
    ns .. ':flow:children:' .. id
  )

  -- 2. If this job is a child, remove it from parent's children set
  if parentId then
    redis.call('SREM', ns .. ':flow:children:' .. parentId, id)
  end

  removed = removed + 1
end

return removed


