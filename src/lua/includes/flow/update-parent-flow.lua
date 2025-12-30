--- @include "includes/group-lifecycle/update-group-ready-limited-state"

--[[
  更新父任务流 (Update Parent Flow)
  
  当子任务完成时，跟踪子任务完成结果，并在所有子任务完成后将父任务提升到等待状态
  
  @param options table 参数对象
    - ns: string 命名空间
    - parentId: string 父任务ID
    - childId: string 完成的子任务ID
    - status: string 子任务完成状态 (如 "completed", "failed")
    - resultOrError: string 子任务的结果或错误数据
    - timestamp: number 完成时间戳
    - readyKey: string 就绪队列的 key
    - limitedKey: string 限流队列的 key
  
  @return nil
]]

local function updateParentFlow(options)
  -- 参数解构
  local ns = options.ns
  local parentId = options.parentId
  local childId = options.childId
  local status = options.status
  local resultOrError = options.resultOrError
  local timestamp = options.timestamp
  local readyKey = options.readyKey
  local limitedKey = options.limitedKey

  local parentKey = ns .. ":job:" .. parentId

  -- 1. 存储子任务结果到流结果哈希
  -- Key: flow:results:{parentId}, Field: {childId}
  local flowResultsKey = ns .. ":flow:results:" .. parentId

  -- 包装结果为 {status, data} 结构以便更好地跟踪流
  local flowEntry = cjson.encode({
    status = status,
    data = resultOrError
  })
  redis.call("HSET", flowResultsKey, childId, flowEntry)

  -- 2. 递减剩余子任务计数器
  local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

  -- 3. 如果所有子任务都完成了，将父任务移动到等待状态
  if remaining <= 0 then
    local parentStatus = redis.call("HGET", parentKey, "status")
    if parentStatus == "waiting-children" then
      -- 更新父任务状态为等待
      redis.call("HSET", parentKey, "status", "waiting")

      -- 将父任务添加到其群组和就绪队列
      local parentGroupId = redis.call("HGET", parentKey, "groupId")
      local parentScore = tonumber(redis.call("HGET", parentKey, "score"))

      -- 如果没有设置分数，使用当前时间
      if not parentScore then
        parentScore = tonumber(redis.call("TIME")[1]) * 1000
      end

      -- 将父任务添加到其群组的有序集合
      local pGZ = ns .. ":g:" .. parentGroupId
      redis.call("ZADD", pGZ, parentScore, parentId)
      redis.call("SADD", ns .. ":groups", parentGroupId)

      -- 根据群组容量更新父群组状态（ready/limited）
      local pHead = redis.call("ZRANGE", pGZ, 0, 0, "WITHSCORES")
      if pHead and #pHead >= 2 then
        local pHeadScore = tonumber(pHead[2])
        -- 使用头部分数来表示群组中最早的任务
        updateGroupReadyLimitedState({ ns = ns, groupId = parentGroupId, readyKey = readyKey, limitedKey = limitedKey, headScore = pHeadScore })
      end
    end
  end
end
