--[[
  获取任务锁 (Acquire Job Lock)
  
  BullMQ 风格：创建独立的锁 Key，带 TTL 自动过期
  
  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - token: string 锁令牌
    - ttlMs: number 锁过期时间（毫秒）
  
  @return number 1: 成功获取锁; 0: 锁已被占用
]]

local function acquireLock(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local token = opts.token
  local ttlMs = opts.ttlMs
  
  local lockKey = ns .. ":lock:" .. jobId
  
  -- 使用 SET NX PX 原子性获取锁
  -- NX: 仅当 key 不存在时设置
  -- PX: 设置毫秒级过期时间
  local result = redis.call("SET", lockKey, token, "NX", "PX", ttlMs)
  
  if result then
    return 1
  else
    return 0
  end
end
