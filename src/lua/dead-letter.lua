--- @include "includes/job-lifecycle/move-to-dead-letter"

-- argv: ns, jobId, groupId, token
local ns = KEYS[1]
local jobId = ARGV[1]
local groupId = ARGV[2]
local token = ARGV[3]

-- 使用统一的死信处理模块
-- 该模块会处理Token验证、任务清理、群组状态更新
return moveToDeadLetter({
  ns = ns,
  jobId = jobId,
  groupId = groupId,
  token = token
})

