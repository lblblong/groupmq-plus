--[[
  Read the complete set of job data fields from Redis.

  This retrieves the 10 core fields commonly used in job operations:
  1. id: Unique job identifier
  2. groupId: Group this job belongs to
  3. data: Job payload/arguments (typically JSON)
  4. attempts: Number of times this job has been attempted
  5. maxAttempts: Maximum number of retry attempts allowed
  6. seq: Sequence number for ordering
  7. timestamp: When the job was created
  8. orderMs: Order/priority for sorting within group
  9. score: Current sort key for group zset
  10. isFlowParent: Whether this job spawns child jobs (flow)

  Parameters:
    jobKey: The Redis key for the job hash

  Returns: Array of values in the order listed above
]]
local function getJobFullData(jobKey)
  return redis.call("HMGET", jobKey,
    "id", "groupId", "data", "attempts", "maxAttempts",
    "seq", "timestamp", "orderMs", "score", "isFlowParent"
  )
end
