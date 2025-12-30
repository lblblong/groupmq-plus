-- Common: Queue Empty Checker
-- 统一的队列空状态检查
-- 检查所有可能的队列状态，包括:
--   - 正在处理的任务 (processing)
--   - 延迟的任务 (delayed)
--   - 暂存的任务 (staged)
--   - 就绪的群组 (ready)
--   - 受限的群组 (limited)
--   - 群组中的等待任务 (groups)
-- 参数:
--   opts.ns: 命名空间
--   opts.ignoreDelayed: "1" 忽略延迟任务, "0" 检查延迟任务
--   opts.ignoreStaged: "1" 忽略暂存任务, "0" 检查暂存任务
-- 返回:
--   1 if 队列为空, 0 if 队列非空

local function checkQueueEmpty(opts)
  local ns = opts.ns
  local ignoreDelayed = opts.ignoreDelayed
  local ignoreStaged = opts.ignoreStaged

  -- Check processing jobs (Active)
  local processingCount = redis.call("ZCARD", ns .. ":processing")
  if processingCount > 0 then
    return 0
  end

  -- Check delayed jobs (仅当不忽略时检查)
  if ignoreDelayed ~= "1" then
    local delayedCount = redis.call("ZCARD", ns .. ":delayed")
    if delayedCount > 0 then
      return 0
    end
  end

  -- Check staged jobs (仅当不忽略时检查)
  if ignoreStaged ~= "1" then
    local stagedCount = redis.call("ZCARD", ns .. ":stage")
    if stagedCount > 0 then
      return 0
    end
  end

  -- Check ready groups
  local readyCount = redis.call("ZCARD", ns .. ":ready")
  if readyCount > 0 then
    return 0
  end

  -- Check limited groups
  local limitedCount = redis.call("ZCARD", ns .. ":limited")
  if limitedCount > 0 then
    return 0
  end

  -- Check all groups for waiting jobs
  local groups = redis.call("SMEMBERS", ns .. ":groups")
  for _, gid in ipairs(groups) do
    local gZ = ns .. ":g:" .. gid
    local jobCount = redis.call("ZCARD", gZ)
    if jobCount > 0 then
      return 0
    end
  end

  -- Queue is completely empty
  return 1
end
