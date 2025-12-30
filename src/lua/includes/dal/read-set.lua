-- Data Access Layer: SET Reader
-- 统一的集合读取操作
-- 参数 (Table):
--   key: Redis key (SET)
--   operation: 'count' 或 'members'
-- 返回:
--   如果 operation == 'count': 返回集合中的元素数量
--   如果 operation == 'members': 返回集合中的所有成员列表

local function readSet(opts)
  -- 解构参数
  local key = opts.key
  local operation = opts.operation

  if operation == 'count' then
    return redis.call("SCARD", key)
  elseif operation == 'members' then
    return redis.call("SMEMBERS", key)
  else
    error("Unknown operation: " .. operation)
  end
end
