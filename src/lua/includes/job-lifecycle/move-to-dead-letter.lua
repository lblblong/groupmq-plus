--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

--[[
  将任务标记为死信 (Move to Dead Letter)

  原子性地将任务标记为死信，清理相关数据，更新群组状态

  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - groupId: string 群组ID
    - token: string 用于验证的Token（可选）

  @return number 1: 成功; 0: Token不匹配或任务不存在
]]

local function moveToDeadLetter(opts)
  -- 参数解构
  local ns = opts.ns
  local jobId = opts.jobId
  local groupId = opts.groupId
  local token = opts.token

  local jobKey = ns .. ":job:" .. jobId
  local procKey = ns .. ":processing:" .. jobId
  local gZ = ns .. ":g:" .. groupId
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  -- Token验证: 确保只有正确的worker可以进行死信处理
  -- 特殊处理: 如果token不存在(任务已恢复)则允许继续，但如果token存在且不匹配则拒绝
  local storedToken = redis.call("HGET", procKey, "token")

  if storedToken and storedToken ~= token then
    -- Lock不匹配: 另一个worker正在处理此任务
    return 0
  end
  if not storedToken and token then
    -- 安全检查: 防止对已恢复的任务进行死信处理
    return 0
  end

  -- 从群组ZSET移除
  redis.call("ZREM", gZ, jobId)
  redis.call("ZREM", ns .. ":delayed", jobId)

  -- 递减群组任务计数
  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

  -- 从processing移除
  redis.call("DEL", procKey)
  redis.call("ZREM", ns .. ":processing", jobId)

  -- 移除幂等性映射
  redis.call("DEL", ns .. ":unique:" .. jobId)

  -- 从群组活跃列表移除（使用专门的模块处理）
  removeJobFromActive({
    ns = ns,
    groupId = groupId,
    jobId = jobId
  })

  -- 检查群组是否为空或需要从ready队列移除
  if remainingJobs <= 0 then
    -- 群组为空，移除from ready和limited队列并进行清理
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
    redis.call("DEL", gZ)
    redis.call("DEL", groupMetaKey)
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
    redis.call("DEL", groupActiveKey)
    redis.call("SREM", ns .. ":groups", groupId)
  else
    -- 群组仍有任务，检查是否可以从limited移动到ready
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])

      -- [LIMITED GROUP SET] 检查是否可以从limited移动到ready
      updateGroupReadyLimitedState({ ns = ns, groupId = groupId, readyKey = readyKey, limitedKey = limitedKey, headScore = headScore })
    end
  end

  return 1
end
