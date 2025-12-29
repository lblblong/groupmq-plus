--- @include "includes/retry-handling/handle-job-retry-with-backoff"

-- argv: ns, jobId, backoffMs, token
local ns = KEYS[1]
local jobId = ARGV[1]
local backoffMs = tonumber(ARGV[2]) or 0
local token = ARGV[3]

local groupId = redis.call("HGET", ns .. ":job:" .. jobId, "groupId")

return handleJobRetryWithBackoff(ns, jobId, groupId, token, backoffMs)
