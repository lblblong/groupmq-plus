--[[
  读取任务数据并进行基础验证 (Fetch Job Data)

  根据 JobID 读取所有标准字段，返回 Table。
  如果 ID 不存在或数据损坏，返回 nil。

  @param options table 参数对象
    - ns: string 命名空间前缀
    - jobId: string 任务ID

  @return table 或 nil
    成功：{ id, groupId, payload, attempts, maxAttempts, seq, timestamp, orderMs, score, isFlowParent }
    失败（ID 不存在或数据损坏）：nil
]]

local function fetchJobData(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local jobKey = ns .. ":job:" .. jobId

  local job = redis.call("HMGET", jobKey, "id", "groupId", "data", "attempts", "maxAttempts", "seq", "timestamp", "orderMs", "score", "isFlowParent")

  -- 基础校验：如果 ID 为空，说明数据损坏或任务已丢失
  if not job[1] or job[1] == false then
    return nil
  end

  return {
    id = job[1],
    groupId = job[2],
    payload = job[3],
    attempts = job[4],
    maxAttempts = job[5],
    seq = job[6],
    timestamp = job[7],
    orderMs = job[8],
    score = job[9],
    isFlowParent = job[10]
  }
end
