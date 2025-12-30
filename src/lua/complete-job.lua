--- @include "includes/security/verify-token"
--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/flow/update-parent-flow"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/group-lifecycle/cleanup-if-group-empty"
--- @include "includes/job-lifecycle/record-job-finalization"
--- @include "includes/group-status/get-group-head-job"

--[[
  完成任务 (Complete Job)
  
  统一的任务完成脚本，合并了原有的 complete.lua, complete-with-metadata.lua, record-job-result.lua
  原子性地解锁群组并记录元数据
  
  KEYS[1]: ns - 命名空间
  ARGV[1]: jobId - 任务ID
  ARGV[2]: groupId - 群组ID
  ARGV[3]: status - 状态 ('completed' | 'failed')
  ARGV[4]: timestamp - 时间戳
  ARGV[5]: resultOrError - 结果或错误信息 (JSON)
  ARGV[6]: keepCompleted - 保留完成记录数
  ARGV[7]: keepFailed - 保留失败记录数
  ARGV[8]: processedOn - 处理开始时间
  ARGV[9]: finishedOn - 完成时间
  ARGV[10]: attempts - 尝试次数
  ARGV[11]: maxAttempts - 最大尝试次数
  ARGV[12]: token - 处理令牌
  
  返回值:
    - 1: 成功
    - 0: 失败（任务已被处理或令牌无效）
]]

local ns = KEYS[1]
local jobId = ARGV[1]
local gid = ARGV[2]
local status = ARGV[3]
local timestamp = tonumber(ARGV[4])
local resultOrError = ARGV[5]
local keepCompleted = tonumber(ARGV[6])
local keepFailed = tonumber(ARGV[7])
local processedOn = ARGV[8]
local finishedOn = ARGV[9]
local attempts = ARGV[10]
local maxAttempts = ARGV[11]
local token = ARGV[12]

local jobKey = ns .. ":job:" .. jobId
local processingKey = ns .. ":processing"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- 在可能删除任务之前获取 parentId
local parentId = redis.call("HGET", jobKey, "parentId")

-- Part 1: 原子性验证并标记完成（防止重复处理）

-- 关键：同时检查状态和 processing 集合成员资格
-- 这可以防止与 stalled job recovery 的竞态
local jobStatus = redis.call("HGET", jobKey, "status")
local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

-- 如果任务不在 "processing" 状态或不在 processing 集合中，这是延迟/重复的
if jobStatus ~= "processing" or not stillInProcessing then
  return 0
end

-- 令牌验证
if not verifyToken(ns, jobId, token) then
  return 0
end

-- 原子性标记为完成中并从 processing 移除
redis.call("HSET", jobKey, "status", "completing") -- 临时状态以阻止 stalled checker
local procKey = ns .. ":processing:" .. jobId
redis.call("DEL", procKey)
redis.call("ZREM", processingKey, jobId)

-- 从活跃列表移除任务（使用 Options Object 模式）
removeJobFromActive({
  ns = ns,
  groupId = gid,
  jobId = jobId
})

-- 递减群组任务计数
local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
redis.call("HINCRBY", groupMetaKey, "count", -1)

-- 检查群组中是否还有更多任务并更新状态
local nextJobId = getGroupHeadJob(ns, gid)
if nextJobId then
  -- 群组还有更多任务，更新 ready/limited 状态
  local gZ = ns .. ":g:" .. gid
  local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if nextHead and #nextHead >= 2 then
    local nextScore = tonumber(nextHead[2])
    updateGroupReadyLimitedState({ ns = ns, groupId = gid, readyKey = readyKey, limitedKey = limitedKey, headScore = nextScore })
  end
else
  -- 没有更多任务，清理群组
  cleanupIfGroupEmpty({
    ns = ns,
    groupId = gid
  })
end

-- Part 2: 如果这是子任务，更新父任务流
if parentId then
  updateParentFlow({
    ns = ns,
    parentId = parentId,
    childId = jobId,
    status = status,
    resultOrError = resultOrError,
    timestamp = timestamp,
    readyKey = readyKey,
    limitedKey = limitedKey
  })
end

-- Part 3: 记录任务元数据（完成或失败）
local keepCount = (status == "completed") and keepCompleted or keepFailed
recordJobFinalization({
  ns = ns,
  jobId = jobId,
  status = status,
  resultOrError = resultOrError,
  finishedOn = finishedOn,
  keepCount = keepCount,
  processedOn = processedOn,
  attempts = attempts,
  maxAttempts = maxAttempts
})

return 1
