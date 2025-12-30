--- @include "includes/dal/iterate-groups"

-- Get count of waiting jobs (tasks in all groups)
local ns = KEYS[1]
return iterateGroups(ns, 'count')


