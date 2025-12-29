--[[
  Verify processing token matches stored token

  Prevents multiple workers from completing the same job.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID
    expectedToken: The token to verify against stored token

  Returns: true if token matches or no token verification needed, false if mismatch
]]
local function verifyToken(ns, jobId, expectedToken)
  if not expectedToken then return true end

  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  -- Token doesn't match or stored token exists but doesn't match expected
  return not storedToken or storedToken == expectedToken
end
