-- 入参: ns, jobId, groupId, token (可选)
-- 功能: 原子性地从处理集合移除任务，清理相关键
-- 返回: "token-mismatch" | "cleaned"

local function cleanupProcessingJob(ns, jobId, groupId, token)
  local procKey = ns .. ":processing:" .. jobId

  -- 可选的令牌验证
  if token then
    local storedToken = redis.call("HGET", procKey, "token")
    if storedToken and storedToken ~= token then
      return "token-mismatch"
    end
  end

  -- 清理处理数据
  redis.call("DEL", procKey)
  redis.call("ZREM", ns .. ":processing", jobId)

  -- 从活跃列表移除
  if groupId then
    redis.call("LREM", ns .. ":g:" .. groupId .. ":active", 1, jobId)
  end

  return "cleaned"
end

