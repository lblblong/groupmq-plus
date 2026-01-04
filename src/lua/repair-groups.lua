--- @include "includes/group-lifecycle/refresh-group-state"

--[[
  Repair Groups Batch Script (Watchdog 机制 - 批量版本)
  
  对传入的一批群组调用 refreshGroupState 修复可能处于"隐身"状态的群组。
  用于解决 reserveBlocking 过程中因进程崩溃导致的 Redis 群组 ID 丢失问题。
  
  采用批量处理模式，避免在单个 Lua 脚本中处理所有群组导致 Redis 阻塞。
  
  KEYS[1]: 命名空间 (ns)
  ARGV[1]: JSON 数组格式的 groupIds，例如 ["group1", "group2", ...]
  
  Returns: 处理的群组数量
]]

local ns = KEYS[1]
local readyKey = ns .. ":ready"
local limitedKey = ns .. ":limited"

-- 解析传入的 groupIds JSON 数组
local groupIds = cjson.decode(ARGV[1])
local count = 0

-- 遍历每个群组，调用 refreshGroupState 进行状态修复
for _, groupId in ipairs(groupIds) do
  refreshGroupState({
    ns = ns,
    groupId = groupId,
    readyKey = readyKey,
    limitedKey = limitedKey
  })
  count = count + 1
end

return count
