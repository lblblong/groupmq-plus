-- Data Access Layer: Group Iterator
-- 统一的群组迭代操作
-- 参数:
--   ns: 命名空间
--   operation: 'count' 或 'list'
-- 返回:
--   如果 operation == 'count': 返回所有群组中任务的总数
--   如果 operation == 'list': 返回所有群组中的任务ID列表

local function iterateGroups(ns, operation)
  local groupsKey = ns .. ":groups"
  local groupIds = redis.call("SMEMBERS", groupsKey)

  if operation == 'count' then
    local total = 0
    for _, gid in ipairs(groupIds) do
      local gk = ns .. ":g:" .. gid
      total = total + (redis.call("ZCARD", gk) or 0)
    end
    return total
  elseif operation == 'list' then
    local jobs = {}
    for _, gid in ipairs(groupIds) do
      local gZ = ns .. ":g:" .. gid
      local groupJobs = redis.call("ZRANGE", gZ, 0, -1)
      for _, jobId in ipairs(groupJobs) do
        table.insert(jobs, jobId)
      end
    end
    return jobs
  else
    error("Unknown operation: " .. operation)
  end
end
