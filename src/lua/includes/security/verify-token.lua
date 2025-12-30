-- Security module: Verify token for job processing
-- Purpose: Ensure that the token provided matches the stored token in the processing lock
-- This prevents unauthorized job completion attempts
--
-- Function: verifyToken(opts)
-- Parameters:
--   opts.ns: namespace (string)
--   opts.jobId: job ID (string)
--   opts.token: token to verify (string)
-- Returns:
--   boolean: true if token is valid, false otherwise

local function verifyToken(opts)
  local ns = opts.ns
  local jobId = opts.jobId
  local token = opts.token
  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  -- If processing key doesn't exist (already deleted) or token doesn't match
  if not storedToken or storedToken ~= token then
    return false
  end

  return true
end
