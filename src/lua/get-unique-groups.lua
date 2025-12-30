--- @include "includes/dal/read-set"

-- Get list of all unique groups
-- argv: ns
local ns = KEYS[1]
local groupsKey = ns .. ":groups"
return readSet(groupsKey, 'members')


