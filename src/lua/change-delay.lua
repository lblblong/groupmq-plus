--- @include "includes/dal/get-job-state"
--- @include "includes/group-lifecycle/refresh-group-state"
--- @include "includes/delayed-handling/promote-delayed-job-complete"

-- argv: ns, jobId, newDelayUntil, now
local ns = KEYS[1]
local jobId = ARGV[1]
local newDelayUntil = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Validate required parameters
if not newDelayUntil or not now then
  return 0
end

local jobKey = ns .. ":job:" .. jobId
local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- Check if job exists
local exists = redis.call("EXISTS", jobKey)
if exists == 0 then
  return 0
end

local groupId = redis.call("HGET", jobKey, "groupId")
if not groupId then
  return 0
end

local gZ = ns .. ":g:" .. groupId

-- 使用 get-job-state 模块检查任务状态
local jobState = getJobState({
  ns = ns,
  jobId = jobId,
  groupId = groupId
})

-- 只允许修改 'waiting' 或 'delayed' 状态的任务延迟时间
-- 不允许修改 'active', 'completed', 'failed' 状态的任务
if jobState ~= 'waiting' and jobState ~= 'delayed' then
  return 0
end

-- Update job's delayUntil field
redis.call("HSET", jobKey, "delayUntil", tostring(newDelayUntil))


if newDelayUntil > 0 and newDelayUntil > now then
  -- Job should be delayed: add to delayed set and REMOVE from group ZSET
  redis.call("HSET", jobKey, "status", "delayed")
  redis.call("ZADD", delayedKey, newDelayUntil, jobId)
  redis.call("ZREM", gZ, jobId)

  -- Use centralized refresh module to handle group state
  refreshGroupState({
    ns = ns,
    groupId = groupId,
    readyKey = readyKey,
    limitedKey = limitedKey
  })
else
  -- Job should be ready immediately: promote using standard function
  promoteDelayedJobToWaiting({ ns = ns, jobId = jobId, delayedKey = delayedKey, readyKey = readyKey, limitedKey = limitedKey })
end

return 1


