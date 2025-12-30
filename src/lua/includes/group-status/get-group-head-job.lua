--[[
  Get the head (first) job in a group's job set.

  The head job is the next one that would be processed/reserved.

  Parameters (options table):
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Job ID if group has jobs, nil otherwise
]]
local function getGroupHeadJob(opts)
  -- 参数解构
  local ns = opts.ns
  local groupId = opts.groupId

  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0)
  if head and #head > 0 then
    return head[1]
  end
  return nil
end
