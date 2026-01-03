--[[
  数据访问层：群组迭代器 (Group Iterator)
  
  统一的群组迭代操作，支持计数和列表查询，并具有硬限制保护。
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.operation: 操作类型 ('count' 或 'list')
    opts.limit: 可选，列表操作时的最大返回任务数 (默认 1000)
  
  Returns:
    如果 operation == 'count': 返回所有群组中任务的总数
    如果 operation == 'list': 返回所有群组中的任务ID列表 (受 limit 限制)
]]

local function iterateGroups(opts)
  -- 解构参数
  local ns = opts.ns
  local operation = opts.operation
  local limit = opts.limit or 1000

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
    local jobCount = 0
    
    -- 遍历所有群组，收集任务，但受 limit 限制
    for _, gid in ipairs(groupIds) do
      if jobCount >= limit then
        -- 已达到限制，立即停止
        break
      end
      
      local gZ = ns .. ":g:" .. gid
      local groupJobs = redis.call("ZRANGE", gZ, 0, -1)
      
      for _, jobId in ipairs(groupJobs) do
        if jobCount >= limit then
          -- 达到限制，立即返回
          break
        end
        table.insert(jobs, jobId)
        jobCount = jobCount + 1
      end
    end
    
    return jobs
  else
    error("Unknown operation: " .. operation)
  end
end
