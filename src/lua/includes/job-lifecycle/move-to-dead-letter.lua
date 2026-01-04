--- @include "includes/group-state/remove-job-from-active"
--- @include "includes/group-lifecycle/refresh-group-state"
--- @include "includes/lock/release-lock"

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
  redis.call("HINCRBY", groupMetaKey, "count", -1)

  -- 从processing移除
  redis.call("DEL", procKey)
  redis.call("ZREM", ns .. ":processing", jobId)

  -- [BullMQ 风格] 释放独立锁
  releaseLock({ ns = ns, jobId = jobId, token = token })

  -- 移除幂等性映射
  redis.call("DEL", ns .. ":unique:" .. jobId)

  -- 从群组活跃列表移除（使用专门的模块处理）
  removeJobFromActive({
    ns = ns,
    groupId = groupId,
    jobId = jobId
  })

  -- 使用统一的群组状态刷新模块处理群组清理和 ready/limited 队列更新
  refreshGroupState({
    ns = ns,
    groupId = groupId,
    readyKey = readyKey,
    limitedKey = limitedKey
  })

  return 1
end
