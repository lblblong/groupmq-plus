--- @include "includes/dal/read-zset"

-- Get list of delayed jobs
local ns = KEYS[1]
local delayedKey = ns .. ":delayed"
return readZset(delayedKey, 'range')


