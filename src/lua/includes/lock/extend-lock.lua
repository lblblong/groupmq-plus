--[[
  续期任务锁 (Extend Job Lock)
  
  BullMQ 风格：延长锁的 TTL，仅当 token 匹配时
  
  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - token: string 锁令牌
    - ttlMs: number 新的过期时间（毫秒）
  
  @return number 1: 续期成功; 0: token 不匹配或锁不存在
]]

local function extendLock(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local token = opts.token
  local ttlMs = opts.ttlMs
  
  local lockKey = ns .. ":lock:" .. jobId
  
  -- 检查 token 是否匹配
  local storedToken = redis.call("GET", lockKey)
  
  if storedToken == token then
    -- Token 匹配，续期锁
    redis.call("PEXPIRE", lockKey, ttlMs)
    return 1
  else
    -- Token 不匹配或锁不存在
    return 0
  end
end
