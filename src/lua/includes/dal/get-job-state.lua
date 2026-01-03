--[[
  获取任务的物理状态 (Get Job State)
  
  通过系统化的检查，返回任务在 Redis 中的当前状态。
  这避免了在代码各处重复手动进行 ZSCORE 和其他检查。
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.jobId: 任务 ID
    opts.groupId: 群组 ID (可选，如提供可加速 'waiting' 状态检查)
  
  Returns: 
    'active' - 任务在 processing 集合中
    'delayed' - 任务在 delayed 集合中
    'waiting' - 任务在群组的有序集合中（需传入 groupId 或会检查所有群组）
    'completed' - 任务已完成
    'failed' - 任务已失败
    'unknown' - 任务状态无法确定
]]

local function getJobState(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local groupId = opts.groupId

  local jobKey = ns .. ":job:" .. jobId

  -- 1. 检查是否在 processing (active 状态)
  local inProcessing = redis.call("ZSCORE", ns .. ":processing", jobId)
  if inProcessing then
    return 'active'
  end

  -- 2. 检查是否在 delayed (delayed 状态)
  local inDelayed = redis.call("ZSCORE", ns .. ":delayed", jobId)
  if inDelayed then
    return 'delayed'
  end

  -- 3. 检查是否在群组的有序集合中 (waiting 状态)
  if groupId then
    local gZ = ns .. ":g:" .. groupId
    local inGroup = redis.call("ZSCORE", gZ, jobId)
    if inGroup then
      return 'waiting'
    end
  else
    -- 如果没有提供 groupId，尝试从任务本身获取
    local jobGroupId = redis.call("HGET", jobKey, "groupId")
    if jobGroupId then
      local gZ = ns .. ":g:" .. jobGroupId
      local inGroup = redis.call("ZSCORE", gZ, jobId)
      if inGroup then
        return 'waiting'
      end
    end
  end

  -- 4. 检查是否已完成
  -- 先检查 completed 集合（快速检查）
  local inCompleted = redis.call("ZSCORE", ns .. ":completed", jobId)
  if inCompleted then
    return 'completed'
  end
  
  -- 如果不在 completed 集合中，检查 job hash 中的 status 字段
  local jobStatus = redis.call("HGET", jobKey, "status")
  if jobStatus == "completed" then
    return 'completed'
  end

  -- 5. 检查是否已失败
  -- 先检查 failed 集合（快速检查）
  local inFailed = redis.call("ZSCORE", ns .. ":failed", jobId)
  if inFailed then
    return 'failed'
  end
  
  -- 如果不在 failed 集合中，检查 job hash 中的 status 字段
  if jobStatus == "failed" then
    return 'failed'
  end

  -- 6. 如果任务存在但状态未知
  local jobExists = redis.call("EXISTS", jobKey)
  if jobExists == 1 then
    return 'unknown'
  end

  -- 7. 任务不存在
  return 'unknown'
end
