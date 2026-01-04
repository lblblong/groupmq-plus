--[[
  检查任务锁状态 (Check Job Lock)
  
  BullMQ 风格：检查锁是否存在
  
  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
  
  @return number 1: 锁存在; 0: 锁不存在（已过期或被释放）
]]

local function checkLock(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  
  local lockKey = ns .. ":lock:" .. jobId
  
  return redis.call("EXISTS", lockKey)
end
