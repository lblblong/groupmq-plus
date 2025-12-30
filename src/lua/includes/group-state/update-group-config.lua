-- Update group configuration
-- Parameters:
--   opts.ns: namespace
--   opts.groupId: group ID
--   opts.configJson: JSON string containing config
--
-- This function decodes the configJson and updates the group's config hash in Redis.
-- If configJson is empty or "null", no action is taken.

local function updateGroupConfig(opts)
  local ns = opts.ns
  local groupId = opts.groupId
  local configJson = opts.configJson

  if configJson and configJson ~= "" and configJson ~= "null" then
    local status, config = pcall(cjson.decode, configJson)
    if status and config then
      local configKey = ns .. ":config:" .. groupId
      local args = {}
      for k, v in pairs(config) do
        if v ~= nil then
          table.insert(args, k)
          table.insert(args, tostring(v))
        end
      end
      if #args > 0 then
        redis.call("HMSET", configKey, unpack(args))
      end
    end
  end
end
