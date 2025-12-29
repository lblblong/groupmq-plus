--- @include "includes/concurrency-control/is-group-at-capacity"

-- 入参: ns, groupId, readyKey, limitedKey, optionalHeadScore
-- 功能: 根据活跃计数和并发限制，自动将组置于 ready 或 limited 队列
-- 如果不提供headScore，会从群组中获取

local function updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
  if not headScore then
    local gZ = ns .. ":g:" .. groupId
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if not head or #head < 2 then return end
    headScore = tonumber(head[2])
  end

  if isGroupAtCapacity(ns, groupId) then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZADD", limitedKey, headScore, groupId)
  else
    redis.call("ZREM", limitedKey, groupId)
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end

