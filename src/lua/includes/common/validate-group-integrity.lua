--[[
  验证群组完整性 (Validate Group Integrity)
  
  检查群组是否为空或被物理删除。
  如果是，则从 Ready/Limited 全局队列中清理，防止死循环。
  如果有效，顺便返回头部任务的分数（为了性能优化，避免重复查询）。

  Parameters:
    opts.ns: 命名空间
    opts.groupId: 群组 ID
    opts.readyKey: Ready 队列 Key
    opts.limitedKey: Limited 队列 Key
    
  Returns: 
    number: 群组有效，返回头部任务 Score
    nil: 群组无效（空或不存在），已执行清理
]]

local function validateGroupIntegrity(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey

  local gZ = ns .. ":g:" .. groupId
  
  -- 获取群组头部信息
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  
  if not head or #head < 2 then
    -- 群组为空或不存在，清理全局状态
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZREM", limitedKey, groupId)
    return nil
  end

  -- 返回头部 Score，供后续逻辑使用
  return tonumber(head[2])
end
