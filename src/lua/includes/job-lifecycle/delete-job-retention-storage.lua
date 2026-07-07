--[[
  删除任务在 Redis 中的存储数据

  用于保留策略修剪、立即删除等场景。
  不处理队列索引、组状态、父子 flow 关系同步——那些由 deleteJobCompletely / clean-status 负责。

  @param options table 参数对象
    - ns: string 命名空间
    - jobId: string 任务 ID

  @return number DEL 命令删除的 key 数量
]]

local function deleteJobRetentionStorage(options)
  local ns = options.ns
  local jobId = options.jobId

  return redis.call(
    "DEL",
    ns .. ":job:" .. jobId,
    ns .. ":unique:" .. jobId,
    ns .. ":flow:results:" .. jobId,
    ns .. ":flow:children:" .. jobId
  )
end
