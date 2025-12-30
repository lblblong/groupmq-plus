--- @include "includes/common/check-queue-empty"

-- Check if the queue is completely empty
-- argv: ns
local ns = KEYS[1]
return checkQueueEmpty(ns)

