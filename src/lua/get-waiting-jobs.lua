--- @include "includes/dal/iterate-groups"

-- Get list of waiting jobs (tasks in all groups)
-- argv: ns
local ns = KEYS[1]
return iterateGroups(ns, 'list')


