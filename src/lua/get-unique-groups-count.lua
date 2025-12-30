--- @include "includes/dal/read-set"

-- Get count of unique groups
-- argv: ns
local ns = KEYS[1]
local groupsKey = ns .. ":groups"
return readSet(groupsKey, 'count')
