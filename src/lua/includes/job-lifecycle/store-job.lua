-- Job lifecycle module: Store job
-- Purpose: Encapsulate job data construction and storage logic
--
-- Function: storeJob(ns, jobId, groupId, data, opts)
-- Parameters:
--   ns: namespace (string)
--   jobId: job ID (string)
--   groupId: group ID (string)
--   data: job data payload (string/JSON)
--   opts: table with options:
--     - maxAttempts: max retry attempts (number)
--     - timestamp: job creation timestamp (number)
--     - orderMs: ordering timestamp (number)
--     - delayUntil: delay deadline (number)
--     - clientTimestamp: client timestamp for accuracy (number)
-- Returns:
--   table: {score, seq} containing generated score and sequence

local function storeJob(ns, jobId, groupId, data, opts)
  opts = opts or {}

  local maxAttempts = opts.maxAttempts or 0
  local orderMs = opts.orderMs or (tonumber(redis.call("TIME")[1]) * 1000)
  local delayUntil = opts.delayUntil or 0
  local clientTimestamp = opts.clientTimestamp

  local jobKey = ns .. ":job:" .. jobId

  -- Generate sequence number
  local baseEpoch = 1704067200000
  local relativeMs = orderMs - baseEpoch
  local daysSinceEpoch = math.floor(orderMs / 86400000)
  local seqKey = ns .. ":seq:" .. daysSinceEpoch
  local seq = redis.call("INCR", seqKey)
  local score = relativeMs * 1000 + seq

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
