--- @param opts table Options object
--- @param opts.ns string 命名空间
--- @return boolean true 如果队列被暂停，否则 false
local function isQueuePaused(opts)
  local ns = opts.ns
  return redis.call("GET", ns .. ":paused") and true or false
end
