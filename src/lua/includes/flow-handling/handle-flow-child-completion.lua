--- @include "includes/group-lifecycle/update-group-ready-limited-state"

-- 入参: ns, jobId, parentId, status, resultOrError
-- 功能: 记录子任务结果，递减计数，可能激活父任务
-- 返回: "no-parent" | "handled"

local function handleFlowChildCompletion(ns, jobId, parentId, status, resultOrError)
  if not parentId then return "no-parent" end

  local parentKey = ns .. ":job:" .. parentId
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

  -- 1. 存储子任务结果
  local flowResultsKey = ns .. ":flow:results:" .. parentId
  local flowEntry = cjson.encode({
    status = status,
    data = resultOrError
  })
  redis.call("HSET", flowResultsKey, jobId, flowEntry)

  -- 2. 递减剩余计数
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

  -- 3. 如果所有子任务完成，激活父任务
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      redis.call("HSET", parentKey, "status", "waiting")

      -- 将父任务加入群组
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end

      if parentGroupId and parentScore then
        local pGZ = ns .. ":g:" .. parentGroupId
        redis.call("ZADD", pGZ, parentScore, parentId)
        redis.call("SADD", ns .. ":groups", parentGroupId)

        -- 更新群组状态（ready 或 limited）
        local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
        if pHead and #pHead >= 2 then
          local pHeadScore = tonumber(pHead[2])
          updateGroupReadyLimitedState(ns, parentGroupId, readyKey, limitedKey, pHeadScore)
        end
      end
    end
  end

  return "handled"
end
