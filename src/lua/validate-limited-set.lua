-- Validate the limited group set for consistency
-- Returns: {total, valid, invalid, missing}
-- invalid: groups in limited that shouldn't be (no jobs or activeCount < limit)
-- missing: groups that should be in limited but aren't (activeCount >= limit with jobs)

local ns = KEYS[1]
local limitedKey = ns .. ":limited"
local readyKey = ns .. ":ready"

local stats = {
  total = 0,
  valid = 0,
  invalid = {},
  missing = {}
}

-- Check all groups currently in limited
local limitedGroups = redis.call("ZRANGE", limitedKey, 0, -1)
stats.total = #limitedGroups

for i = 1, #limitedGroups do
  local gid = limitedGroups[i]
  local gZ = ns .. ":g:" .. gid
  local groupActiveKey = ns .. ":g:" .. gid .. ":active"
  local configKey = ns .. ":config:" .. gid
  
  local jobCount = redis.call("ZCARD", gZ)
  local currentActive = redis.call("LLEN", groupActiveKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
  
  -- Check 1: Group must have jobs
  if jobCount == 0 then
    table.insert(stats.invalid, {
      gid = gid,
      reason = "empty_group",
      jobCount = 0,
      activeCount = currentActive,
      limit = limit
    })
  -- Check 2: Group must be at capacity
  elseif currentActive < limit then
    table.insert(stats.invalid, {
      gid = gid,
      reason = "not_at_capacity",
      jobCount = jobCount,
      activeCount = currentActive,
      limit = limit
    })
  -- Check 3: Group must NOT be in ready queue
  elseif redis.call("ZSCORE", readyKey, gid) then
    table.insert(stats.invalid, {
      gid = gid,
      reason = "in_both_ready_and_limited",
      jobCount = jobCount,
      activeCount = currentActive,
      limit = limit
    })
  else
    -- Valid entry
    stats.valid = stats.valid + 1
  end
end

-- Check for missing entries: groups with jobs at capacity but not in limited
local allGroups = redis.call("SMEMBERS", ns .. ":groups")
for i = 1, #allGroups do
  local gid = allGroups[i]
  local gZ = ns .. ":g:" .. gid
  local groupActiveKey = ns .. ":g:" .. gid .. ":active"
  local configKey = ns .. ":config:" .. gid
  
  local jobCount = redis.call("ZCARD", gZ)
  local currentActive = redis.call("LLEN", groupActiveKey)
  local limit = tonumber(redis.call("HGET", configKey, "concurrency")) or 1
  
  -- Check if should be in limited but isn't
  if jobCount > 0 and currentActive >= limit then
    local isInLimited = redis.call("ZSCORE", limitedKey, gid)
    if not isInLimited then
      table.insert(stats.missing, {
        gid = gid,
        jobCount = jobCount,
        activeCount = currentActive,
        limit = limit
      })
    end
  end
end

return cjson.encode(stats)
