export const GET_GROUPS_AGING_LUA = `
local ns = KEYS[1]
local limit = tonumber(ARGV[1]) or 100
local defaultPriority = tonumber(ARGV[2]) or 1
-- 方案特有参数
local now = tonumber(ARGV[3])
local priorityFactor = tonumber(ARGV[4]) or 1000 -- 1点优先级 = 1000ms 等待时间
local scanDepth = tonumber(ARGV[5]) or 500

local readyKey = ns .. ":ready"

-- 1. 深度获取候选组 (Member + Score/ReadyTime)
local raw = redis.call("ZRANGE", readyKey, 0, scanDepth - 1, "WITHSCORES")
local candidates = {}

for i = 1, #raw, 2 do
  local groupId = raw[i]
  local readyTs = tonumber(raw[i+1]) or now
  local waitMs = now - readyTs
  if waitMs < 0 then waitMs = 0 end

  -- 获取优先级
  local configKey = ns .. ":config:" .. groupId
  local priorityStr = redis.call("HGET", configKey, "priority")
  local priority = tonumber(priorityStr) or defaultPriority

  -- 2. 计算虚拟得分 (分数越高越优先)
  -- 公式：基础优先级加成 + 等待时间加成
  -- 比如 priorityFactor=60000，意味着高1级 priority 等同于多等了1分钟
  local vScore = (priority * priorityFactor) + waitMs

  table.insert(candidates, {
    id = groupId,
    p = priority,
    ts = 0, -- 此脚本我们不需要返回原始 ts，或者可以在这里再查 job ts，为了性能这里暂略
    vScore = vScore
  })
end

-- 3. Lua 内部排序 (降序)
table.sort(candidates, function(a, b) return a.vScore > b.vScore end)

-- 4. 截取前 limit 个，并补全数据
local result = {}
local count = 0
for _, item in ipairs(candidates) do
  if count >= limit then break end
  
  -- 为了兼容 PriorityStrategy 的接口，我们需要 job timestamp
  -- 这里按需查询，减少 Redis 压力
  local oldestTs = 0
  local gZ = ns .. ":g:" .. item.id
  local headJob = redis.call("ZRANGE", gZ, 0, 0)
  if headJob and #headJob > 0 then
    local jobTs = redis.call("HGET", ns .. ":job:" .. headJob[1], "timestamp")
    oldestTs = tonumber(jobTs) or 0
  end
  item.ts = oldestTs

  -- 清理掉 vScore 字段，返回给客户端纯净结构
  table.insert(result, {
    id = item.id,
    p = item.p,
    ts = item.ts
  })
  count = count + 1
end

return cjson.encode(result)
`;