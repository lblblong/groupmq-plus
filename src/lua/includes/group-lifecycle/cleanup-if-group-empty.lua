-- 入参: ns, groupId, jobCountChange (通常为 -1)
-- 功能: 原子性地递减计数，如果为0则清理所有群组键
-- 返回: "empty" 表示组已清空，"has-jobs" 表示组仍有任务

local function cleanupIfGroupEmpty(ns, groupId, jobCountChange)
  jobCountChange = jobCountChange or -1

  local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
  local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", jobCountChange))

  if remainingJobs <= 0 then
    -- 清理所有群组相关键
    local gZ = ns .. ":g:" .. groupId
    redis.call("DEL", gZ)
    redis.call("DEL", ns .. ":g:" .. groupId .. ":active")
    redis.call("DEL", groupMetaKey)
    redis.call("DEL", ns .. ":buffer:" .. groupId)
    redis.call("SREM", ns .. ":groups", groupId)
    redis.call("ZREM", ns .. ":ready", groupId)
    redis.call("ZREM", ns .. ":limited", groupId)
    redis.call("ZREM", ns .. ":buffering", groupId)

    return "empty"
  end

  return "has-jobs"
end
