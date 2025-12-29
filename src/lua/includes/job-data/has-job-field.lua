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
