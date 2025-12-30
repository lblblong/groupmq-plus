--- @include "includes/dal/read-zset"
--- @include "includes/dal/iterate-groups"

--[[
  获取队列指标 (Get Queue Metrics)
  
  合并了原有的 get-active-count, get-waiting-count, get-delayed-count 脚本
  
  KEYS[1]: ns - 命名空间
  ARGV[1]: types - 可选，指定要获取的类型 ('active'|'waiting'|'delayed')
                   不传则返回所有类型的计数
  
  返回值:
    - 如果指定 types: 返回对应类型的数量 (number)
    - 如果不指定 types: 返回 JSON 字符串 {"active":N,"waiting":N,"delayed":N}
]]

local ns = KEYS[1]
local types = ARGV[1]

-- 获取 active 数量 (processing 队列)
local function getActiveCount()
  local processingKey = ns .. ":processing"
  return readZset(processingKey, 'count')
end

-- 获取 waiting 数量 (所有群组中的任务)
local function getWaitingCount()
  return iterateGroups(ns, 'count')
end

-- 获取 delayed 数量
local function getDelayedCount()
  local delayedKey = ns .. ":delayed"
  return readZset(delayedKey, 'count')
end

-- 根据 types 参数决定返回内容
if types == 'active' then
  return getActiveCount()
elseif types == 'waiting' then
  return getWaitingCount()
elseif types == 'delayed' then
  return getDelayedCount()
else
  -- 返回所有指标的 JSON
  local active = getActiveCount()
  local waiting = getWaitingCount()
  local delayed = getDelayedCount()
  return cjson.encode({
    active = active,
    waiting = waiting,
    delayed = delayed
  })
end
