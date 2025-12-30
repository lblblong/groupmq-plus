--- @param ns string 命名空间
--- @return boolean true 如果队列被暂停，否则 false
local function isQueuePaused(ns)
  return redis.call("GET", ns .. ":paused") and true or false
end
