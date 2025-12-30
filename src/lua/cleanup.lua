--- @include "includes/job-recovery/recover-single-job"

-- argv: ns, nowEpochMs
local ns = KEYS[1]
local now = tonumber(ARGV[1])

local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"
local processingKey = ns .. ":processing"
local cleaned = 0

local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
for _, jobId in ipairs(expiredJobs) do
  -- CRITICAL: Verify job is STILL in processing to avoid race conditions
  local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

  if stillInProcessing then
    local procKey = ns .. ":processing:" .. jobId
    local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
    local gid = procData[1]
    local deadlineAt = tonumber(procData[2])

    if gid and deadlineAt and now > deadlineAt then
      local jobKey = ns .. ":job:" .. jobId
      local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
      local jobScore = tonumber(jobData[1])
      local delayUntil = tonumber(jobData[2]) or 0

      if jobScore then
        -- Use centralized recovery module
        recoverSingleJob({ ns = ns, jobId = jobId, groupId = gid, jobScore = jobScore, delayUntil = delayUntil, now = now, readyKey = readyKey, limitedKey = limitedKey, processingKey = processingKey })
        cleaned = cleaned + 1
      end
    end
  end
end

return cleaned



