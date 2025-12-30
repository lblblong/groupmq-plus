--- @include "includes/dal/read-zset"

-- Get count of active (processing) jobs
-- argv: ns
local ns = KEYS[1]
local processingKey = ns .. ":processing"
return readZset(processingKey, 'count')


