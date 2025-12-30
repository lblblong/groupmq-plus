--[[
  从活跃列表移除任务 (Remove Job from Active List)
  
  安全地从群组的活跃任务列表中移除任务
  处理正常情况（任务在列表头部）和竞态条件（任务在列表其他位置）
  
  @param options table 参数对象
    - ns: string 命名空间
    - groupId: string 群组ID
    - jobId: string 任务ID
  
  @return nil
]]

local function removeJobFromActive(options)
  -- 参数解构
  local ns = options.ns
  local groupId = options.groupId
  local jobId = options.jobId

  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

  -- 获取活跃列表的头部
  local headJobId = redis.call("LINDEX", groupActiveKey, 0)

  if headJobId == jobId then
    -- 正常情况：任务在活跃列表头部
    redis.call("LPOP", groupActiveKey)
  else
    -- 竞态条件：任务不在头部，但仍需移除以防止过期条目
    -- 这可能发生在另一个 worker 已经处理并移除了它，
    -- 或者任务被乱序处理
    redis.call("LREM", groupActiveKey, 1, jobId)
  end
end
