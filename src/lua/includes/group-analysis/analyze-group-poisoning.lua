-- Group analysis module: Detect poisoned groups
-- Purpose: Check if a group has any jobs that can still be processed
--
-- @param options table 参数对象
--   - ns: string namespace
--   - groupId: string group ID to analyze
-- @return boolean true if group is poisoned (all jobs exhausted attempts), false if still has recoverable jobs

local function analyzeGroupPoisoning(opts)
  local ns = opts.ns
  local groupId = opts.groupId

  local gZ = ns .. ":g:" .. groupId

  -- Get all jobs in the group
  local jobs = redis.call("ZRANGE", gZ, 0, -1)

  -- Check if any job can still be reserved (attempts < maxAttempts)
  for i = 1, #jobs do
    local jobId = jobs[i]
    local jobKey = ns .. ":job:" .. jobId
    local attempts = tonumber(redis.call("HGET", jobKey, "attempts")) or 0
    local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts")) or 0

    -- If any job still has retries available, group is not poisoned
    if attempts < maxAttempts then
      return false
    end
  end

  -- All jobs have exhausted their attempts
  return true
end
