--[[
  Generate job sequence number and score

  Encapsulates the logic to calculate epoch, generate seq, and compute score
  based on orderMs

  @param opts table 参数对象
    - ns: string 命名空间
    - orderMs: number 排序时间戳

  @return table {score, seq} 生成的得分和序列号
]]

local function generateJobSeq(opts)
  local ns = opts.ns
  local orderMs = opts.orderMs

  -- Generate sequence number
  local baseEpoch = 1704067200000
  local relativeMs = orderMs - baseEpoch
  local daysSinceEpoch = math.floor(orderMs / 86400000)
  local seqKey = ns .. ":seq:" .. daysSinceEpoch
  local seq = redis.call("INCR", seqKey)
  local score = relativeMs * 1000 + seq

  return {score, seq}
end
