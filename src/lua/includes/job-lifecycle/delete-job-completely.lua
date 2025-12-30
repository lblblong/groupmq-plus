--- @include "includes/flow/remove-child-from-parent"
--- @include "includes/group-lifecycle/cleanup-if-group-empty"

-- 入参: ns, jobId
-- 功能: 完整清理一个任务及其关联的所有数据结构（包括flow关系）
-- 返回: "deleted" | "not-found"

local function deleteJobCompletely(ns, jobId)
  local jobKey = ns .. ":job:" .. jobId
  local delayedKey = ns .. ":delayed"
  local processingKey = ns .. ":processing"
  local readyKey = ns .. ":ready"
  local limitedKey = ns .. ":limited"

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
    if status ~= "completed" and status ~= "failed" then
      redis.call("HINCRBY", groupMetaKey, "count", -1)
    end

    -- 使用cleanup helper处理群组清理和ready/limited队列更新
    cleanupIfGroupEmpty({
      ns = ns,
      groupId = groupId
    })
  end

  -- 删除任务散列、flow结果和子任务跟踪
  redis.call("DEL",
    jobKey,
    ns .. ":flow:results:" .. jobId,
    ns .. ":flow:children:" .. jobId
  )

  -- 清理flow关系：如果此任务是子任务，从父任务的子任务集中移除
  if parentId then
    removeChildFromParent({ ns = ns, parentId = parentId, childId = jobId, readyKey = readyKey, limitedKey = limitedKey })
  end

  return "deleted"
end
