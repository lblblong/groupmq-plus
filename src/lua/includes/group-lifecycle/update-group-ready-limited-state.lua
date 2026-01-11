--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/common/validate-group-integrity"

-- 入参:
--   opts.ns: 命名空间
--   opts.groupId: 群组ID
--   opts.readyKey: ready集合key
--   opts.limitedKey: limited集合key
--   opts.headScore: 可选，群组头任务的score；如果不提供，会从群组中获取
-- 功能: 根据活跃计数和并发限制，自动将组置于 ready 或 limited 队列

local function updateGroupReadyLimitedState(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey
  local headScore = opts.headScore

  if not headScore then
    headScore = validateGroupIntegrity({
      ns = ns,
      groupId = groupId,
      readyKey = readyKey,
      limitedKey = limitedKey
    })

    -- 群组为空或不存在，validateGroupIntegrity 已完成清理
    if not headScore then return end
  end

  if isGroupAtCapacity({ ns = ns, groupId = groupId }) then
    redis.call("ZREM", readyKey, groupId)
    redis.call("ZADD", limitedKey, headScore, groupId)
  else
    redis.call("ZREM", limitedKey, groupId)
    redis.call("ZADD", readyKey, headScore, groupId)
  end
end

