--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/concurrency-control/is-group-at-capacity"

--[[
  将延迟任务晋升到等待队列 (Promote Delayed Job to Waiting)
  
  @param options table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - delayedKey: string 延迟集合的 Redis key
    - readyKey: string 就绪集合的 Redis key
    - limitedKey: string 限流集合的 Redis key
  
  @return string "not-found" | "invalid-data" | "promoted"
]]

local function promoteDelayedJobToWaiting(options)
  -- 参数解构
  local ns = options.ns
  local jobId = options.jobId
  local delayedKey = options.delayedKey
  local readyKey = options.readyKey
  local limitedKey = options.limitedKey

  local jobKey = ns .. ":job:" .. jobId

  -- 基本验证
  if redis.call("EXISTS", jobKey) == 0 then return "not-found" end

  -- 从延迟集合移除
  redis.call("ZREM", delayedKey, jobId)

  -- 获取群组和分数
  local groupId = redis.call("HGET", jobKey, "groupId")
  local score = tonumber(redis.call("HGET", jobKey, "score"))

  if not groupId or not score then return "invalid-data" end

  -- 标记为等待状态
  redis.call("HSET", jobKey, "status", "waiting")
  redis.call("HDEL", jobKey, "runAt", "delayUntil")

  -- 加入群组等待集合
  local gZ = ns .. ":g:" .. groupId
  redis.call("ZADD", gZ, score, jobId)
  redis.call("SADD", ns .. ":groups", groupId)

  -- 更新群组状态（ready 或 limited）
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    local headScore = tonumber(head[2])
    updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
  end

  return "promoted"
end
