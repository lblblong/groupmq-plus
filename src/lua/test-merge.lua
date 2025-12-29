--[[
  Test script to verify nested @include merging works correctly.

  This script includes a function that itself has dependencies,
  testing the recursive resolution capability of the new loader.
]]
--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-status/get-group-job-count"

-- Test 1: Direct call to included function
local capacity = isGroupAtCapacity(KEYS[1], ARGV[1])

-- Test 2: Transitive dependency (get-group-job-count is loaded transitively)
local jobCount = getGroupJobCount(KEYS[1], ARGV[1])

return {capacity, jobCount}
