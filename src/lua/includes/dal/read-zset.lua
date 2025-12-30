-- Data Access Layer: ZSET Reader
-- 统一的有序集合读取操作
-- 参数:
--   key: Redis key (ZSET)
--   operation: 'count' 或 'range'
--   start: 开始索引 (用于 'range' 操作，可选)
--   stop: 结束索引 (用于 'range' 操作，可选)
-- 返回:
--   如果 operation == 'count': 返回集合中的元素数量
--   如果 operation == 'range': 返回指定范围内的元素列表

local function readZset(key, operation, start, stop)
  if operation == 'count' then
    return redis.call("ZCARD", key)
  elseif operation == 'range' then
    -- 默认返回所有元素
    if not start then start = 0 end
    if not stop then stop = -1 end
    return redis.call("ZRANGE", key, start, stop)
  else
    error("Unknown operation: " .. operation)
  end
end
