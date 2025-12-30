--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/delayed-handling/promote-delayed-job-complete"

--[[
  晋升延迟任务 (Promote Delayed Jobs)
  
  合并了原有的 promote-delayed-jobs 和 promote-delayed-one 脚本
  
  KEYS[1]: ns - 命名空间
  ARGV[1]: now - 当前时间戳
  ARGV[2]: limit - 可选，晋升数量限制 (默认 -1 表示全部，传 1 表示一条)
  
  返回值:
    - 成功晋升的任务数量 (number)
]]

local ns = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2]) or -1

local delayedKey = ns .. ":delayed"
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

local promotedCount = 0

-- 根据 limit 参数决定获取方式
local readyJobs
if limit == 1 then
  -- 只获取一条
  readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now, "LIMIT", 0, 1)
elseif limit > 1 then
  -- 获取指定数量
  readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now, "LIMIT", 0, limit)
else
  -- 获取全部 (limit == -1 或未指定)
  readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now)
end

if not readyJobs or #readyJobs == 0 then
  return 0
end

for i = 1, #readyJobs do
  local jobId = readyJobs[i]

  -- 使用 Options Object 模式调用晋升函数
  local result = promoteDelayedJobToWaiting({
    ns = ns,
    jobId = jobId,
    delayedKey = delayedKey,
    readyKey = readyKey,
    limitedKey = limitedKey
  })

  if result == "promoted" then
    promotedCount = promotedCount + 1
  end
end

return promotedCount
