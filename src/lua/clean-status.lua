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
    
    -- [PHYSICAL SEPARATION] Decrement group job count ONLY if it was in an active state (delayed)
    local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
    local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0
    
    if status == "delayed" then
      remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
    end

    if remainingJobs <= 0 then

      redis.call('ZREM', readyKey, groupId)
      redis.call('ZREM', limitedKey, groupId)
      -- Clean up empty group
      redis.call('DEL', gZ)
      redis.call('DEL', groupMetaKey)
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
    local parentKey = ns .. ':job:' .. parentId
    local parentChildrenKey = ns .. ':flow:children:' .. parentId

    local removedFromSet = redis.call('SREM', parentChildrenKey, id)
    if removedFromSet == 1 then
      -- Also remove any recorded child result on parent (avoid stale childrenValues entries)
      redis.call('HDEL', ns .. ':flow:results:' .. parentId, id)

      local remaining = redis.call('HINCRBY', parentKey, 'flowRemaining', -1)

      if remaining <= 0 then
        local parentStatus = redis.call('HGET', parentKey, 'status')
        if parentStatus == 'waiting-children' then
          redis.call('HSET', parentKey, 'status', 'waiting')

          local parentGroupId = redis.call('HGET', parentKey, 'groupId')
          if parentGroupId then
            local parentScore = tonumber(redis.call('HGET', parentKey, 'score'))
            if not parentScore then
              parentScore = tonumber(redis.call('TIME')[1]) * 1000
            end

            local pGZ = ns .. ':g:' .. parentGroupId
            redis.call('ZADD', pGZ, parentScore, parentId)
            redis.call('SADD', ns .. ':groups', parentGroupId)

            local pHead = redis.call('ZRANGE', pGZ, 0, 0, 'WITHSCORES')
            if pHead and #pHead >= 2 then
              local pHeadScore = tonumber(pHead[2])
              local pGroupActiveKey = ns .. ':g:' .. parentGroupId .. ':active'
              local pConfigKey = ns .. ':config:' .. parentGroupId
              local pLimit = tonumber(redis.call('HGET', pConfigKey, 'concurrency')) or 1
              local pCurrentActive = redis.call('LLEN', pGroupActiveKey)

              if pCurrentActive >= pLimit then
                redis.call('ZREM', readyKey, parentGroupId)
                redis.call('ZADD', limitedKey, pHeadScore, parentGroupId)
              else
                redis.call('ZREM', limitedKey, parentGroupId)
                redis.call('ZADD', readyKey, pHeadScore, parentGroupId)
              end
            end
          end
        end
      end
    end
  end

  removed = removed + 1
end

return removed


