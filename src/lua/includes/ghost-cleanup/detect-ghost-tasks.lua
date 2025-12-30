--[[
  Check if a group has ghost tasks without cleaning them.
  Useful for debugging and monitoring.

  @param options table 参数对象
    - ns: string Redis namespace prefix
    - groupId: string The group ID
    - processingKey: string optional override for processing key (default: ns:processing)

  @return number Number of ghost tasks detected
]]
local function detectGhostTasks(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local processingKey = opts.processingKey or (ns .. ":processing")

  local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

  local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
  local ghostCount = 0

  for _, jobId in ipairs(activeJobs) do
    local score = redis.call("ZSCORE", processingKey, jobId)
    if not score then
      ghostCount = ghostCount + 1
    end
  end

  return ghostCount
end
