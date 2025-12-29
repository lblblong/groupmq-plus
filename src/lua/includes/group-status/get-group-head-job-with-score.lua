--[[
  Get the head job with its score.

  Parameters:
    ns: Redis namespace prefix
    groupId: The group ID

  Returns: Array [jobId, score] if group has jobs, nil otherwise
]]
--- @include "includes/group-status/get-group-head-job"

local function getGroupHeadJobWithScore(ns, groupId)
  local gZ = ns .. ":g:" .. groupId
  local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
  if head and #head >= 2 then
    return {head[1], tonumber(head[2])}
  end
  return nil
end
