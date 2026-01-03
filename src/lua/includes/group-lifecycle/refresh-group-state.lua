--- @include "includes/group-lifecycle/cleanup-if-group-empty"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"

--[[
  统一的群组状态刷新模块 (Refresh Group State)
  
  目标：消除重复的"检查群组是否为空，为空则清理，不为空则更新 Ready/Limited 状态"的样板代码。
  该模块原子性地处理群组的清理和状态更新操作。
  
  Parameters:
    opts.ns: Redis 命名空间前缀
    opts.groupId: 群组 ID
    opts.readyKey: ready 集合的 key
    opts.limitedKey: limited 集合的 key
  
  Returns: "cleaned" 如果群组被完全清理, "not-empty" 如果群组仍有任务
]]

local function refreshGroupState(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local readyKey = opts.readyKey
  local limitedKey = opts.limitedKey

  -- 首先调用 cleanupIfGroupEmpty，检查群组是否为空
  local cleanupResult = cleanupIfGroupEmpty({
    ns = ns,
    groupId = groupId
  })

  -- 如果返回值为 "not-empty"，说明群组还有任务，需要更新 Ready/Limited 状态
  if cleanupResult == "not-empty" then
    -- updateGroupReadyLimitedState 会自动获取 headScore，
    -- 不需要在这里手动获取，直接传入参数让其内部处理
    updateGroupReadyLimitedState({
      ns = ns,
      groupId = groupId,
      readyKey = readyKey,
      limitedKey = limitedKey
    })
  end

  -- 返回清理的结果
  return cleanupResult
end
