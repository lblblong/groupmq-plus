--[[
  释放任务锁 (Release Job Lock)
  
  BullMQ 风格：删除锁 Key，仅当 token 匹配时
  
  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - token: string 锁令牌（可选，如果不提供则强制删除）
  
  @return number 1: 释放成功; 0: token 不匹配
]]

local function releaseLock(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local token = opts.token
  
  local lockKey = ns .. ":lock:" .. jobId
  
  if token then
    -- 验证 token 后删除
    local storedToken = redis.call("GET", lockKey)
    if storedToken == token then
      redis.call("DEL", lockKey)
      return 1
    else
      return 0
    end
  else
    -- 强制删除（用于 stalled recovery）
    redis.call("DEL", lockKey)
    return 1
  end
end
