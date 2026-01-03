--- @include "includes/job-lifecycle/generate-job-seq"

--[[
  存储任务 (Store Job)

  将任务数据存储到 Redis，生成时间戳和序列号

  @param opts table 参数对象
    - ns: string 命名空间
    - jobId: string 任务ID
    - groupId: string 群组ID
    - data: string 任务数据（JSON）
    - maxAttempts: number 最大重试次数 (可选，默认0)
    - timestamp: number 任务创建时间戳 (可选)
    - orderMs: number 排序时间戳 (可选)
    - delayUntil: number 延迟截止时间 (可选，默认0)
    - clientTimestamp: number 客户端时间戳 (可选)

  @return table {score, seq} 生成的得分和序列号
]]

local function storeJob(opts)
  -- 参数解构
  local ns = opts.ns
  local jobId = opts.jobId
  local groupId = opts.groupId
  local data = opts.data

  local maxAttempts = opts.maxAttempts or 0
  local orderMs = opts.orderMs or (tonumber(redis.call("TIME")[1]) * 1000)
  local delayUntil = opts.delayUntil or 0
  local clientTimestamp = opts.clientTimestamp

  local jobKey = ns .. ":job:" .. jobId

  -- Generate sequence number and score using shared module
  local result = generateJobSeq({ ns = ns, orderMs = orderMs })
  local score = result[1]
  local seq = result[2]

  -- Get Redis server time
  local timeResult = redis.call("TIME")
  local now = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

  -- Use client timestamp if provided, otherwise use server time
  local timestamp = clientTimestamp or now

  -- Store job data
  redis.call("HMSET", jobKey,
    "id", jobId,
    "groupId", groupId,
    "data", data,
    "attempts", "0",
    "maxAttempts", tostring(maxAttempts),
    "seq", tostring(seq),
    "timestamp", tostring(timestamp),
    "orderMs", tostring(orderMs),
    "score", tostring(score),
    "delayUntil", tostring(delayUntil)
  )

  -- Track group membership (idempotent)
  redis.call("SADD", ns .. ":groups", groupId)
  redis.call("HINCRBY", ns .. ":g:" .. groupId .. ":meta", "count", 1)

  return {score, seq}
end
