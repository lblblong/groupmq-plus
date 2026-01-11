--[[
  验证任务完整性 (Validate Job Integrity)
  
  检查任务 Hash 是否存在。如果不存在（被手动误删），
  则从引用的集合（如 delayed, staged 等）中移除该 ID，实现自愈。

  Parameters:
    opts.ns: 命名空间
    opts.jobId: 任务 ID
    opts.refKey: (可选) 当前所在的集合 Key (如 delayedKey)，用于清理脏数据
    
  Returns: 
    true: 任务存在，数据完整
    false: 任务缺失，已执行清理
]]

local function validateJobIntegrity(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local refKey = opts.refKey

  local jobKey = ns .. ":job:" .. jobId

  if redis.call("EXISTS", jobKey) == 0 then
    -- 任务 Hash 不存在，执行清理
    if refKey then
      redis.call("ZREM", refKey, jobId)
    end
    return false
  end

  return true
end
