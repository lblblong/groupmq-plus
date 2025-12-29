--[[
  Token Verification

  This module handles verification of processing tokens to ensure
  that only the correct worker who locked a job can perform operations on it.

  This is crucial for:
  - Preventing multiple workers from completing the same job
  - Ensuring staled job recovery doesn't interfere with current processing
  - Protecting against race conditions in distributed job execution

  Used by: retry.lua, dead-letter.lua, and other job completion scripts
]]

--[[
  Verify that a processing token matches the one stored for a job.

  Token verification ensures that only the worker that locked the job
  can modify it. If the tokens don't match, it likely means:
  - The job was recovered/reassigned to another worker
  - Another worker already took the lock
  - The worker's lock expired

  Verification rules:
  1. If no token expected: always valid (true)
  2. If token expected and stored: must match exactly
  3. If token provided but nothing stored: invalid (false) - job was recovered
  4. If nothing provided and nothing stored: valid (true) - no verification needed

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID to verify
    expectedToken: The token to verify (nil if no verification needed)

  Returns: true if verification passed, false if failed
]]
local function verifyToken(ns, jobId, expectedToken)
  -- If no token provided, skip verification
  if not expectedToken then
    return true
  end

  local procKey = ns .. ":processing:" .. jobId
  local storedToken = redis.call("HGET", procKey, "token")

  -- Token mismatch or token provided but nothing stored = verification failed
  if storedToken and storedToken ~= expectedToken then
    return false
  end

  if not storedToken and expectedToken then
    return false
  end

  return true
end

--[[
  Get the current token for a job (if any).

  This is useful for debugging and monitoring token state.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: The token string if it exists, or nil if none
]]
local function getJobToken(ns, jobId)
  local procKey = ns .. ":processing:" .. jobId
  return redis.call("HGET", procKey, "token")
end

--[[
  Check if a job has an active processing lock (i.e., is currently being processed).

  A job has an active lock if there's a processing key with a token.

  Parameters:
    ns: Redis namespace prefix
    jobId: The job ID

  Returns: true if job has an active lock, false otherwise
]]
local function hasActiveLock(ns, jobId)
  local procKey = ns .. ":processing:" .. jobId
  local token = redis.call("HGET", procKey, "token")
  return token ~= nil and token ~= false
end
