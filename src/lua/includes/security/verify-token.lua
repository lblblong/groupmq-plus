--[[
  Security module: Verify token for job processing
  
  Purpose: Ensure that the token provided matches the stored token in the processing lock
  This prevents unauthorized job completion attempts
  
  @param opts table 参数对象
    - ns: namespace (string)
    - jobId: job ID (string)
    - token: token to verify (string)
  
  @return number
    - 1: token matches (valid)
    - 0: token doesn't match (taken by another worker)
    - -1: key doesn't exist (already stalled/cleaned up)
]]

local function verifyToken(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local token = opts.token
  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  -- If processing key doesn't exist (already deleted/stalled)
  if not storedToken then
    return -1
  end

  -- If token doesn't match (taken by another worker)
  if storedToken ~= token then
    return 0
  end

  -- Token matches
  return 1
end
