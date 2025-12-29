--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/concurrency-control/is-group-at-capacity"

-- 入参: ns, jobId, delayedKey, readyKey, limitedKey
-- 功能: 从延迟集合移动到群组等待集合，更新群组状态
-- 返回: "not-found" | "invalid-data" | "promoted"

local function promoteDelayedJobToWaiting(ns, jobId, delayedKey, readyKey, limitedKey)
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
