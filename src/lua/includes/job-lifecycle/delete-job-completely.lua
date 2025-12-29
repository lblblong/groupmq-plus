--- @include "includes/concurrency-control/is-group-at-capacity"

-- 入参: ns, jobId
-- 功能: 完整清理一个任务及其关联的所有数据结构（包括flow关系）
-- 返回: "deleted" | "not-found"

local function deleteJobCompletely(ns, jobId)
  local jobKey = ns .. ":job:" .. jobId
  local delayedKey = ns .. ":delayed"
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"
  local processingKey = ns .. ":processing"

  -- 如果任务不存在，返回0
  if redis.call("EXISTS", jobKey) == 0 then
    return "not-found"
  end

  local jobData = redis.call("HMGET", jobKey, "groupId", "parentId", "status")
  local groupId = jobData[1]
  local parentId = jobData[2]
  local status = jobData[3]

  -- 从延迟和处理结构中移除
  redis.call("ZREM", delayedKey, jobId)
  redis.call("DEL", ns .. ":processing:" .. jobId)
  redis.call("ZREM", processingKey, jobId)

  -- 从完成/失败保留集中移除
  redis.call("ZREM", ns .. ":completed", jobId)
  redis.call("ZREM", ns .. ":failed", jobId)

  -- 删除幂等性映射
  redis.call("DEL", ns .. ":unique:" .. jobId)

  -- 如果有群组，更新群组ZSET和ready队列
  if groupId then
    local gZ = ns .. ":g:" .. groupId
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
    redis.call("ZREM", gZ, jobId)
    redis.call("LREM", groupActiveKey, 1, jobId)

    -- 递减群组任务计数（仅当任务非完成/失败状态时）
    local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
    local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0

    if status ~= "completed" and status ~= "failed" then
      remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
    end

    if remainingJobs <= 0 then
      -- 清理空群组
      redis.call("ZREM", readyKey, groupId)
      redis.call("ZREM", limitedKey, groupId)
      redis.call("DEL", gZ)
      redis.call("DEL", groupActiveKey)
      redis.call("DEL", groupMetaKey)
      redis.call("SREM", ns .. ":groups", groupId)
    else
      -- 更新群组状态
      local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
      if head and #head >= 2 then
        local headScore = tonumber(head[2])
        local configKey = ns .. ":config:" .. groupId
        local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
        local currentActive = redis.call("LLEN", groupActiveKey)

        if currentActive >= limit then
          -- 群组已满，保持在limited
          redis.call("ZREM", readyKey, groupId)
          redis.call("ZADD", limitedKey, headScore, groupId)
        else
          -- 群组有空位，移到ready
          redis.call("ZREM", limitedKey, groupId)
          redis.call("ZADD", readyKey, headScore, groupId)
        end
      end
    end
  end

  -- 删除任务散列、flow结果和子任务跟踪
  redis.call("DEL",
    jobKey,
    ns .. ":flow:results:" .. jobId,
    ns .. ":flow:children:" .. jobId
  )

  -- 清理flow关系
  -- 如果此任务是子任务，从父任务的子任务集中移除
  if parentId then
    local parentKey = ns .. ":job:" .. parentId
    local parentChildrenKey = ns .. ":flow:children:" .. parentId

    local removedFromSet = redis.call("SREM", parentChildrenKey, jobId)
    if removedFromSet == 1 then
      -- 同时删除父任务中记录的子结果
      redis.call("HDEL", ns .. ":flow:results:" .. parentId, jobId)

      -- 递减剩余计数
      local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

      -- 如果所有子任务已解决，将父任务移到等待状态
      if remaining <= 0 then
        local parentStatus = redis.call("HGET", parentKey, "status")
        if parentStatus == "waiting-children" then
          redis.call("HSET", parentKey, "status", "waiting")

          local parentGroupId = redis.call("HGET", parentKey, "groupId")
          if parentGroupId then
            local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
            if not parentScore then
              parentScore = tonumber(redis.call("TIME")[1]) * 1000
            end

            local pGZ = ns .. ":g:" .. parentGroupId
            redis.call("ZADD", pGZ, parentScore, parentId)
            redis.call("SADD", ns .. ":groups", parentGroupId)

            -- 根据群组容量更新ready/limited
            local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
            if pHead and #pHead >= 2 then
              local pHeadScore = tonumber(pHead[2])
              local pGroupActiveKey = ns .. ":g:" .. parentGroupId .. ":active"
              local pConfigKey = ns .. ":config:" .. parentGroupId
              local pLimit = tonumber(redis.call("HGET", pConfigKey, "concurrency")) or 1
              local pCurrentActive = redis.call("LLEN", pGroupActiveKey)

              if pCurrentActive >= pLimit then
                redis.call("ZREM", readyKey, parentGroupId)
                redis.call("ZADD", limitedKey, pHeadScore, parentGroupId)
              else
                redis.call("ZREM", limitedKey, parentGroupId)
                redis.call("ZADD", readyKey, pHeadScore, parentGroupId)
              end
            end
          end
        end
      end
    end
  end

  return "deleted"
end
