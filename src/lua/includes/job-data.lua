--[[
  Job Data Reading & Validation

  This module handles reading and parsing job data from Redis.
  It provides a standard interface for accessing the common job fields
  used throughout the job queue system.

  Used by: reserve.lua, reserve-atomic.lua, reserve-batch.lua,
           enqueue-flow.lua, and other job processing scripts
]]

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

--[[
  Parse raw job data array into a named object for easier access.

  Parameters:
    jobData: Array returned from getJobFullData()

  Returns: Table with named fields:
    {
      id = jobData[1],
      groupId = jobData[2],
      payload = jobData[3],
      attempts = jobData[4],
      maxAttempts = jobData[5],
      seq = jobData[6],
      timestamp = jobData[7],
      orderMs = jobData[8],
      score = jobData[9],
      isFlowParent = jobData[10]
    }
]]
local function parseJobData(jobData)
  return {
    id = jobData[1],
    groupId = jobData[2],
    payload = jobData[3],
    attempts = jobData[4],
    maxAttempts = jobData[5],
    seq = jobData[6],
    timestamp = jobData[7],
    orderMs = jobData[8],
    score = jobData[9],
    isFlowParent = jobData[10]
  }
end

--[[
  Validate that job data is complete and not corrupted.

  A job is considered valid if it has an ID and the ID is not false
  (Redis returns false for missing keys).

  Parameters:
    jobData: Array returned from getJobFullData()

  Returns: true if job data is valid, false if corrupted/missing
]]
local function validateJobData(jobData)
  return jobData[1] and jobData[1] ~= false
end

--[[
  Check if a job has a specific field set.

  Parameters:
    jobData: Array returned from getJobFullData()
    fieldIndex: 1-based index of the field to check (1=id, 2=groupId, etc.)

  Returns: true if the field at index exists and is not false
]]
local function hasJobField(jobData, fieldIndex)
  return jobData[fieldIndex] and jobData[fieldIndex] ~= false
end

--[[
  Convert job data array to a string format suitable for returning from Lua scripts.

  Used to construct the return value for scripts that need to send job data to clients.

  Parameters:
    parsed: Result from parseJobData()
    deadline: The deadline timestamp for this job
    token: The processing token for this reservation
    delimiter: String to use as separator (default: "|||")

  Returns: Formatted string with all job data concatenated
]]
local function formatJobDataString(parsed, deadline, token, delimiter)
  delimiter = delimiter or "|||"
  return parsed.id .. delimiter ..
         parsed.groupId .. delimiter ..
         parsed.payload .. delimiter ..
         parsed.attempts .. delimiter ..
         parsed.maxAttempts .. delimiter ..
         parsed.seq .. delimiter ..
         parsed.timestamp .. delimiter ..
         parsed.orderMs .. delimiter ..
         parsed.score .. delimiter ..
         deadline .. delimiter ..
         (parsed.isFlowParent or "0") .. delimiter ..
         token
end
