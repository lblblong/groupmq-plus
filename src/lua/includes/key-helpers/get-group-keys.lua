--[[
  Get all standard Redis keys for a specific group.

  Useful for debugging and cleanup operations.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Table with all relevant keys:
    {
      groupSet = key for group job set,
      configHash = key for group config,
      activeList = key for active tasks,
      lockKey = key for group lock,
      metaHash = key for group metadata
    }
]]
--- @include "includes/key-helpers/make-group-key"
--- @include "includes/key-helpers/make-config-key"
--- @include "includes/key-helpers/make-active-list-key"
--- @include "includes/key-helpers/make-group-lock-key"
--- @include "includes/key-helpers/make-group-meta-key"

local function getGroupKeys(ns, groupId)
  return {
    groupSet = makeGroupKey(ns, groupId),
    configHash = makeConfigKey(ns, groupId),
    activeList = makeActiveListKey(ns, groupId),
    lockKey = makeGroupLockKey(ns, groupId),
    metaHash = makeGroupMetaKey(ns, groupId)
  }
end
