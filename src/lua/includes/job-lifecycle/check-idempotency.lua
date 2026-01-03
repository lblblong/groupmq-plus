--- @include "includes/dal/get-job-state"

--[[
  幂等性检查 (Check Idempotency)
  
  检查任务是否可以入队，通过验证幂等性和任务状态。
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.jobId: 任务 ID
    opts.keepCompleted: 是否保留已完成的任务记录 (默认 0)
  
  Returns: 
    "new" - 任务是新的，可以入队
    "exists" - 任务已存在，无法重复入队
    "stale" - 任务已过期，unique key 被清理，可重新入队
]]

local function checkIdempotency(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local keepCompleted = opts.keepCompleted or 0

  local jobKey = ns .. ":job:" .. jobId
  local uniqueKey = ns .. ":unique:" .. jobId

  -- 尝试获取 unique 锁
  local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")
  if not uniqueSet then
    -- 检测到重复。使用新的 get-job-state 模块获取任务状态
    local jobState = getJobState({
      ns = ns,
      jobId = jobId
    })

    if jobState == 'unknown' then
      -- 任务不存在但 unique key 存在（过期的映射），清理并允许重新入队
      redis.call("DEL", uniqueKey)
      redis.call("SET", uniqueKey, jobId)
      return "stale"
    elseif jobState == 'completed' or jobState == 'failed' then
      -- 任务已完成或失败
      if keepCompleted == 0 then
        -- 不保留已完成的任务，清理并允许重新入队
        redis.call("DEL", jobKey)
        redis.call("DEL", uniqueKey)
        redis.call("SET", uniqueKey, jobId)
        return "stale"
      else
        -- 保留已完成的任务，不允许重新入队
        redis.call("SET", uniqueKey, jobId)
        return "exists"
      end
    else
      -- 任务仍在活跃状态 (active, delayed, waiting)
      -- 不允许重新入队
      redis.call("SET", uniqueKey, jobId)
      return "exists"
    end
  end

  return "new"
end
