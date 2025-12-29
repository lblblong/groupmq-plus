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
--- @include "includes/job-data/get-job-full-data"

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
