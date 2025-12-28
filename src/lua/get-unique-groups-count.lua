-- argv: ns
local ns = KEYS[1]
local groupsKey = ns .. ":groups"
return redis.call("SCARD", groupsKey)
