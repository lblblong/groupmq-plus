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
