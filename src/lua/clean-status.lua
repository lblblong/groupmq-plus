--- @include "includes/flow/remove-child-from-parent"
--- @include "includes/group-lifecycle/refresh-group-state"
--- @include "includes/job-lifecycle/delete-job-retention-storage"

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
    if status == "delayed" then
      redis.call("HINCRBY", groupMetaKey, "count", -1)
    end

    -- 刷新群组状态：空组清理，非空组重新入 ready/limited
    refreshGroupState({
      ns = ns,
      groupId = groupId,
      readyKey = readyKey,
      limitedKey = limitedKey
    })
  end

  -- 删除任务存储及 flow 跟踪数据
  deleteJobRetentionStorage({ ns = ns, jobId = id })

  -- If this job is a child, remove it from parent's children set using the dedicated module
  if parentId then
    removeChildFromParent({ ns = ns, parentId = parentId, childId = id, readyKey = readyKey, limitedKey = limitedKey })
  end

  removed = removed + 1
end

return removed


