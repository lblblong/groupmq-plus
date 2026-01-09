--- @param job table Job object containing id (or jobId), groupId, payload, attempts, maxAttempts, seq, timestamp, orderMs, score, deadline, isFlowParent, token, parentId
--- @return string Formatted job response string with ||| separator
local function formatJobResponse(job)
  local id = job.id or job.jobId
  return id .. "|||" ..
         job.groupId .. "|||" ..
         job.payload .. "|||" ..
         job.attempts .. "|||" ..
         job.maxAttempts .. "|||" ..
         job.seq .. "|||" ..
         job.timestamp .. "|||" ..
         job.orderMs .. "|||" ..
         job.score .. "|||" ..
         job.deadline .. "|||" ..
         (job.isFlowParent or "0") .. "|||" ..
         job.token .. "|||" ..
         (job.parentId or "")
end
