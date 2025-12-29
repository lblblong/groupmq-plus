-- 入参: ns, jobId, jobKey, keepCompleted
-- 功能: 处理任务入队的幂等性检查
-- 返回: "allowed" (继续入队) | "duplicate" (重复任务，已存在)

local function checkEnqueueIdempotence(ns, jobId, jobKey, keepCompleted)
  -- 幂等性检查：确保每个命名空间内的jobId唯一
  local uniqueKey = ns .. ":unique:" .. jobId
  local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")

  if not uniqueSet then
    -- 检测到重复。检查是否是陈旧的unique映射
    local exists = redis.call("EXISTS", jobKey)
    if exists == 0 then
      -- 任务不存在但unique键存在（陈旧），清理后继续
      redis.call("DEL", uniqueKey)
      redis.call("SET", uniqueKey, jobId)
      return "allowed"
    else
      -- 任务存在，检查其状态和位置
      local gid = redis.call("HGET", jobKey, "groupId")
      local inProcessing = redis.call("ZSCORE", ns .. ":processing", jobId)
      local inDelayed = redis.call("ZSCORE", ns .. ":delayed", jobId)
      local inGroup = nil
      if gid then
        inGroup = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
      end

      if (not inProcessing) and (not inDelayed) and (not inGroup) then
        -- 任务不在任何活跃队列中
        if keepCompleted == 0 then
          -- 不保留已完成，删除旧任务
          redis.call("DEL", jobKey)
          redis.call("DEL", uniqueKey)
          redis.call("SET", uniqueKey, jobId)
          return "allowed"
        else
          -- 保留已完成的任务，返回重复（幂等）
          redis.call("SET", uniqueKey, jobId)
          return "duplicate"
        end
      else
        -- 任务仍在活跃队列中
        if keepCompleted == 0 then
          local status = redis.call("HGET", jobKey, "status")
          if status == "completed" then
            -- 任务已完成且不保留，可以重新入队
            redis.call("DEL", jobKey)
            redis.call("DEL", uniqueKey)
            redis.call("SET", uniqueKey, jobId)
            return "allowed"
          else
            -- 任务仍在处理，不允许重复
            redis.call("SET", uniqueKey, jobId)
            return "duplicate"
          end
        end

        -- 二次检查，防止竞态
        local activeAgain = redis.call("ZSCORE", ns .. ":processing", jobId)
        local delayedAgain = redis.call("ZSCORE", ns .. ":delayed", jobId)
        local inGroupAgain = nil
        if gid then
          inGroupAgain = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
        end
        local jobStillExists = redis.call("EXISTS", jobKey)

        if jobStillExists == 1 and (activeAgain or delayedAgain or inGroupAgain) then
          -- 任务仍然活跃，返回重复
          return "duplicate"
        else
          -- 任务已清理，允许重新入队
          return "allowed"
        end
      end
    end
  end

  return "allowed"
end

--- @include "../group-lifecycle/update-group-ready-limited-state"

-- 入参: ns, groupId, jobId, score, delayUntil, readyKey, limitedKey
-- 功能: 根据任务状态决定放入delayed、staged或ready队列
-- 返回: "delayed" | "staged" | "ready" | "limited"

local function placeJobInQueue(ns, groupId, jobId, score, delayUntil, readyKey, limitedKey)
  local readyKey = readyKey or (ns .. ":ready")
  local limitedKey = limitedKey or (ns .. ":limited")
  local delayedKey = ns .. ":delayed"
  local gZ = ns .. ":g:" .. groupId
  local jobKey = ns .. ":job:" .. jobId

  local now = tonumber(redis.call("TIME")[1]) * 1000

  if delayUntil and delayUntil > 0 and delayUntil > now then
    -- 任务处于延迟状态，仅加入延迟集合（物理分离）
    redis.call("ZADD", delayedKey, delayUntil, jobId)
    redis.call("HSET", jobKey, "status", "delayed")
    return "delayed"
  else
    -- 任务立即可用，加入群组并检查并发
    redis.call("ZADD", gZ, score, jobId)
    redis.call("HSET", jobKey, "status", "waiting")

    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if head and #head >= 2 then
      local headScore = tonumber(head[2])
      local configKey = ns .. ":config:" .. groupId
      local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
      local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
      local activeCount = redis.call("LLEN", groupActiveKey)

      updateGroupReadyLimitedState(ns, groupId, readyKey, limitedKey, headScore)
      if activeCount >= limit then
        return "limited"
      else
        return "ready"
      end
    end
  end

  return "waiting"
end

