--- @include "includes/common/check-queue-empty"

-- Check if the queue is completely empty
-- KEYS[1]: ns
-- ARGV[1]: ignoreDelayed ("0" or "1")
-- ARGV[2]: ignoreStaged ("0" or "1")
local ns = KEYS[1]
local ignoreDelayed = ARGV[1] or "0"
local ignoreStaged = ARGV[2] or "0"
return checkQueueEmpty(ns, ignoreDelayed, ignoreStaged)

