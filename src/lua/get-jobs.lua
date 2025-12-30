--- @include "includes/dal/read-zset"
--- @include "includes/dal/iterate-groups"

--[[
  获取任务列表 (Get Jobs)
  
  合并了原有的 get-active-jobs, get-waiting-jobs, get-delayed-jobs 脚本
  
  KEYS[1]: ns - 命名空间
  ARGV[1]: type - 任务类型 ('active'|'waiting'|'delayed')
  ARGV[2]: start - 可选，起始索引 (默认 0)
  ARGV[3]: stop - 可选，结束索引 (默认 -1，表示全部)
  
  返回值:
    - 任务 ID 列表 (array)
]]

local ns = KEYS[1]
local jobType = ARGV[1]
local start = tonumber(ARGV[2]) or 0
local stop = tonumber(ARGV[3]) or -1

if not jobType then
  error("Missing required parameter: type ('active'|'waiting'|'delayed')")
end

if jobType == 'active' then
  -- 从 processing 有序集合获取
  local processingKey = ns .. ":processing"
  return readZset({
    key = processingKey,
    operation = 'range',
    start = start,
    stop = stop
  })
  
elseif jobType == 'waiting' then
  -- 从所有群组获取 (iterate-groups 目前不支持分页，返回全部)
  -- TODO: 如需分页支持，需扩展 iterate-groups
  return iterateGroups({
    ns = ns,
    operation = 'list'
  })
  
elseif jobType == 'delayed' then
  -- 从 delayed 有序集合获取
  local delayedKey = ns .. ":delayed"
  return readZset({
    key = delayedKey,
    operation = 'range',
    start = start,
    stop = stop
  })
  
else
  error("Invalid type: " .. jobType .. ". Expected 'active', 'waiting', or 'delayed'")
end
