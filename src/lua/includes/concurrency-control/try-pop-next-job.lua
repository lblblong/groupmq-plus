--[[
  尝试从群组的等待队列取出下一个任务 (Try Pop Next Job from Group)

  这是一个原子操作，封装了从群组中取出任务的核心逻辑：
  1. 检查群组并发限制
  2. 清理幽灵任务（不在 processingKey 中的活跃任务）
  3. 取出队列头任务
  4. 移动到活跃列表
  5. 标记为处理中状态
  6. 设置截止时间和处理令牌

  @param options table 参数对象
    - ns: string 命名空间前缀
    - groupId: string 群组ID
    - vt: number 可见时间（毫秒）
    - token: string 处理令牌
    - now: number 当前时间戳（毫秒）
    - processingKey: string optional 处理集合的 key，默认为 ns:processing
    - allowedJobId: string optional 允许豁免容量检查的任务ID（用于Chaining）

  @return table 或 nil
    成功：{ jobId, groupId, data, attempts, maxAttempts, seq, timestamp, orderMs, score, isFlowParent, deadline, token }
    失败（没有可用任务或群组满）：nil
]]

--- @include "includes/ghost-cleanup/detect-ghost-tasks"
--- @include "includes/dal/fetch-job-data"

local function tryPopNextJob(options)
  -- 参数解构
  local ns = options.ns
  local groupId = options.groupId
  local vt = options.vt
  local token = options.token
  local now = options.now
  local processingKey = options.processingKey or (ns .. ":processing")
  local allowedJobId = options.allowedJobId  -- [NEW] Optional exemption for chaining

  local gZ = ns .. ":g:" .. groupId
  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
  local configKey = ns .. ":config:" .. groupId

  -- [检查并发限制]
  local activeCount = redis.call("LLEN", groupActiveKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1

  -- [清理幽灵任务]
  -- 触发条件：
  --   1. 如果 activeCount >= limit（原有逻辑，必查），或
  --   2. 如果 activeCount > 0 且 math.random() < 0.01（1%概率随机检查，防止长尾积累）
  local shouldCleanupGhosts = (activeCount >= limit) or (activeCount > 0 and math.random() < 0.01)
  
  if shouldCleanupGhosts then
    local ghostCount = detectGhostTasks({ ns = ns, groupId = groupId, processingKey = processingKey })
    if ghostCount > 0 then
      -- 移除所有幽灵任务
      local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
      for _, jobId in ipairs(activeJobs) do
        local score = redis.call("ZSCORE", processingKey, jobId)
        if not score then
          redis.call("LREM", groupActiveKey, 0, jobId)
        end
      end
      activeCount = math.max(0, activeCount - ghostCount)
    end
  end

  -- [检查容量，支持豁免权]
  local canProceed = false
  
  if activeCount < limit then
    -- 容量充足
    canProceed = true
  elseif allowedJobId then
    -- [NEW] 容量已满，但检查是否提供了豁免权
    -- 检查 allowedJobId 是否在活跃列表中
    local items = redis.call("LRANGE", groupActiveKey, 0, -1)
    for _, id in ipairs(items) do
      if id == allowedJobId then
        -- 豁免权有效，允许继续
        canProceed = true
        break
      end
    end
  end

  -- 如果不能继续，返回 nil
  if not canProceed then
    return nil
  end

  -- [获取队列头任务]
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if not head or #head < 2 then
    return nil
  end

  -- [原子地取出任务]
  local zpop = redis.call("ZPOPMIN", gZ, 1)
  if not zpop or #zpop == 0 then
    return nil
  end

  local jobId = zpop[1]
  local jobKey = ns .. ":job:" .. jobId

  -- [读取并验证任务数据]
  local job = fetchJobData({ ns = ns, jobId = jobId })
  if not job then
    -- 任务 hash 缺失/损坏，返回 nil
    return nil
  end

  local id = job.id
  local retrievedGroupId = job.groupId
  local payload = job.payload
  local attempts = job.attempts
  local maxAttempts = job.maxAttempts
  local seq = job.seq
  local enq = job.timestamp
  local orderMs = job.orderMs
  local score = job.score
  local isFlowParent = job.isFlowParent

  -- [添加到活跃列表]
  redis.call("LPUSH", groupActiveKey, jobId)

  -- [标记为处理中]
  redis.call("HSET", jobKey, "status", "processing")

  -- [设置处理信息]
  local procKey = ns .. ":processing:" .. id
  local deadline = now + vt
  redis.call("HSET", procKey,
    "groupId", groupId,
    "deadlineAt", tostring(deadline),
    "token", token)
  redis.call("ZADD", processingKey, deadline, id)

  -- [返回任务数据]
  -- 返回 table，调用方负责格式化为字符串
  return {
    jobId = id,
    groupId = retrievedGroupId,
    payload = payload,
    attempts = attempts,
    maxAttempts = maxAttempts,
    seq = seq,
    timestamp = enq,
    orderMs = orderMs,
    score = score,
    isFlowParent = isFlowParent or "0",
    deadline = tostring(deadline),  -- 转换为字符串便于返回
    token = token
  }
end
