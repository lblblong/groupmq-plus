/**
 * 这是一个针对 PriorityStrategy 的专用 Lua 脚本
 * 作用：一次性获取 Ready 列表中的组 ID、优先级配置以及最老任务的时间戳
 * 解决了 N+1 查询问题。
 *
 * KEYS[1]: namespace
 * ARGV[1]: limit (batch size)
 * ARGV[2]: defaultPriority
 */
export const GET_WEIGHTED_GROUPS_LUA = `
local ns = KEYS[1]
local limit = tonumber(ARGV[1]) or 100
local defaultPriority = tonumber(ARGV[2]) or 1

local readyKey = ns .. ":ready"

-- 1. 获取候选组列表 (只需一次内存操作)
local groupIds = redis.call("ZRANGE", readyKey, 0, limit - 1)

local result = {}

for _, groupId in ipairs(groupIds) do
  local configKey = ns .. ":config:" .. groupId

  -- 2. 获取优先级
  local priorityStr = redis.call("HGET", configKey, "priority")
  local priority = tonumber(priorityStr) or defaultPriority

  -- 3. 获取最老任务时间戳 (用于 Aging 策略)
  local oldestTs = 0
  local gZ = ns .. ":g:" .. groupId
  local headJob = redis.call("ZRANGE", gZ, 0, 0)
  if headJob and #headJob > 0 then
    local jobTs = redis.call("HGET", ns .. ":job:" .. headJob[1], "timestamp")
    oldestTs = tonumber(jobTs) or 0
  end

  -- 构造结果
  table.insert(result, {
    id = groupId,
    p = priority,
    ts = oldestTs
  })
end

return cjson.encode(result)
`;
