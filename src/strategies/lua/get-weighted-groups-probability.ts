export const GET_GROUPS_PROBABILITY_LUA = `
local ns = KEYS[1]
local limit = tonumber(ARGV[1]) or 100
local defaultPriority = tonumber(ARGV[2]) or 1
-- 方案特有参数
local topPercent = tonumber(ARGV[3]) or 0.8  -- 多少比例给头部 (0-1)
local scanDepth = tonumber(ARGV[4]) or 500   -- 扫描深度

local readyKey = ns .. ":ready"

-- 1. 计算分界线
local limitHigh = math.floor(limit * topPercent)
local limitLow = limit - limitHigh

-- 2. 获取头部 "保送" 组
local resultIds = redis.call("ZRANGE", readyKey, 0, limitHigh - 1)

-- 3. 如果还需要补齐，且扫描深度足够
if limitLow > 0 then
  local tailCandidates = redis.call("ZRANGE", readyKey, limitHigh, scanDepth - 1)
  
  if #tailCandidates > 0 then
    -- Fisher-Yates 洗牌思想，随机抽取 limitLow 个
    -- 注意：Lua 的 math.random 在 Redis 中是确定的，但在较新版本 Redis 5+ 表现良好
    -- 简单的随机抽取实现：
    for i = 1, limitLow do
      if #tailCandidates == 0 then break end
      local idx = math.random(#tailCandidates)
      table.insert(resultIds, tailCandidates[idx])
      -- 移除已选中的，避免重复 (交换到末尾删除是O(1)，table.remove是O(N))
      tailCandidates[idx] = tailCandidates[#tailCandidates]
      table.remove(tailCandidates)
    end
  end
end

-- 4. 组装结果 (获取配置)
local result = {}
for _, groupId in ipairs(resultIds) do
  local configKey = ns .. ":config:" .. groupId
  local priorityStr = redis.call("HGET", configKey, "priority")
  local priority = tonumber(priorityStr) or defaultPriority
  
  -- 获取最老任务时间戳
  local oldestTs = 0
  local gZ = ns .. ":g:" .. groupId
  local headJob = redis.call("ZRANGE", gZ, 0, 0)
  if headJob and #headJob > 0 then
    local jobTs = redis.call("HGET", ns .. ":job:" .. headJob[1], "timestamp")
    oldestTs = tonumber(jobTs) or 0
  end

  table.insert(result, {
    id = groupId,
    p = priority,
    ts = oldestTs
  })
end

return cjson.encode(result)
`;