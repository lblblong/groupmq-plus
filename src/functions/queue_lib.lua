#!lua name=queue_lib

-- ==========================================
-- Queue Management Library for Redis Functions
-- ==========================================
-- This library provides core reusable logic for job queue management
-- Functions are executed atomically on the Redis server
--
-- Key Concepts:
-- - Group-based scheduling with concurrency limits
-- - Parent-child job flow tracking
-- - Token-based job locking for safety
-- - Physical separation of job states (waiting, delayed, staged, processing)
--
-- ==========================================

-- ==========================================
-- 1. INTERNAL HELPER FUNCTIONS
-- ==========================================

-- Get the concurrency limit for a specific group
-- Parameters:
--   ns: namespace prefix
--   groupId: the group identifier
-- Returns: concurrency limit (defaults to 1)
local function getGroupLimit(ns, groupId)
    local configKey = ns .. ":config:" .. groupId
    local limit = redis.call("HGET", configKey, "concurrency")
    return tonumber(limit) or 1
end

-- Update group queue status (ready vs limited) based on current active count
-- This is one of the most frequently reused functions
-- Parameters:
--   ns: namespace prefix
--   groupId: the group identifier
-- Effects:
--   - Moves group to ready queue if has capacity
--   - Moves group to limited queue if at capacity
--   - Removes from both if no waiting jobs
local function updateGroupQueueStatus(ns, groupId)
    local gZ = ns .. ":g:" .. groupId
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"

    -- Get the first waiting job's score (group priority)
    local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if not head or #head == 0 then
        -- No waiting jobs in this group
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZREM", limitedKey, groupId)
        return
    end

    local headScore = tonumber(head[2])
    local limit = getGroupLimit(ns, groupId)
    local currentActive = redis.call("LLEN", groupActiveKey)

    if currentActive >= limit then
        -- Group is at capacity, add to limited queue
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZADD", limitedKey, headScore, groupId)
    else
        -- Group has available slots, add to ready queue
        redis.call("ZREM", limitedKey, groupId)
        redis.call("ZADD", readyKey, headScore, groupId)
    end
end

-- Handle parent-child job flow updates
-- Called when a child job completes to update parent's tracking
-- Parameters:
--   ns: namespace prefix
--   childJobId: the completed child job ID
--   parentId: the parent job ID (or nil/empty)
--   status: final status of child ("completed", "failed", etc)
--   resultOrError: the child's result/error data
--   now: current timestamp
-- Effects:
--   - Records child result in flow:results hash
--   - Decrements parent's remaining counter
--   - Activates parent job when all children complete
local function updateParentFlow(ns, childJobId, parentId, status, resultOrError, now)
    if not parentId or parentId == "" then
        return
    end

    local parentKey = ns .. ":job:" .. parentId
    local flowResultsKey = ns .. ":flow:results:" .. parentId

    -- 1. Store child result in flow results
    local flowEntry = cjson.encode({
        status = status,
        data = resultOrError
    })
    redis.call("HSET", flowResultsKey, childJobId, flowEntry)

    -- 2. Decrement remaining child counter
    local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

    -- 3. If all children completed, activate parent
    if remaining <= 0 then
        local parentStatus = redis.call("HGET", parentKey, "status")
        if parentStatus == "waiting-children" then
            -- Change parent status to waiting
            redis.call("HSET", parentKey, "status", "waiting")

            -- Add parent to its group
            local parentGroupId = redis.call("HGET", parentKey, "groupId")
            local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
            if not parentScore then
                parentScore = now
            end

            local pGZ = ns .. ":g:" .. parentGroupId
            redis.call("ZADD", pGZ, parentScore, parentId)
            redis.call("SADD", ns .. ":groups", parentGroupId)

            -- Update parent group status based on capacity
            updateGroupQueueStatus(ns, parentGroupId)
        end
    end
end

-- Clean up old completed jobs to maintain bounded storage
-- Parameters:
--   ns: namespace prefix
--   keepCount: maximum number of completed jobs to keep
-- Effects:
--   - Removes oldest completed jobs beyond keepCount limit
--   - Deletes associated job hash and unique key for each removed job
local function trimCompleted(ns, keepCount)
    if keepCount <= 0 then
        return
    end

    local completedKey = ns .. ":completed"
    local zcount = redis.call("ZCARD", completedKey)
    local toRemove = zcount - keepCount

    if toRemove > 0 then
        -- Get IDs of oldest jobs to remove
        local oldIds = redis.call("ZRANGE", completedKey, 0, toRemove - 1)

        -- Delete each old job's data
        for _, id in ipairs(oldIds) do
            redis.call("DEL", ns .. ":job:" .. id)
            redis.call("DEL", ns .. ":unique:" .. id)
            redis.call("DEL", ns .. ":flow:results:" .. id)
        end

        -- Remove from completed sorted set
        redis.call("ZREMRANGEBYRANK", completedKey, 0, toRemove - 1)
    end
end

-- Verify token validity for a processing job
-- Parameters:
--   ns: namespace prefix
--   jobId: the job identifier
--   token: the token to verify
-- Returns: true if token is valid, false otherwise
local function isTokenValid(ns, jobId, token)
    if not token then
        return false
    end

    local procKey = ns .. ":processing:" .. jobId
    local storedToken = redis.call("HGET", procKey, "token")

    return storedToken == token
end

-- Atomically move a job between states
-- Parameters:
--   ns: namespace prefix
--   jobId: the job identifier
--   fromState: source state key
--   toState: destination state key
-- Effects:
--   - Removes job from source state set
--   - Adds job to destination state set
--   - Updates job's status field
-- Note: this is a helper that can be expanded as needed
local function moveJob(ns, jobId, fromState, toState, status)
    -- For simple moves, we remove from one set and add to another
    -- The actual keys (like "delayed", "processing", etc) are handled by caller
    if fromState and fromState ~= "" then
        redis.call("ZREM", fromState, jobId)
    end
    if toState and toState ~= "" then
        redis.call("ZADD", toState, redis.call("TIME")[1] * 1000, jobId)
    end
    if status then
        local jobKey = ns .. ":job:" .. jobId
        redis.call("HSET", jobKey, "status", status)
    end
end

-- Get complete job info
-- Parameters:
--   ns: namespace prefix
--   jobId: the job identifier
-- Returns: table with job data or nil if job doesn't exist
local function getJobInfo(ns, jobId)
    local jobKey = ns .. ":job:" .. jobId
    local jobData = redis.call("HGETALL", jobKey)

    if not jobData or #jobData == 0 then
        return nil
    end

    -- Convert flat array to hash table
    local job = {}
    for i = 1, #jobData, 2 do
        job[jobData[i]] = jobData[i + 1]
    end

    return job
end

-- ==========================================
-- 2. EXPORTED PUBLIC FUNCTIONS
-- ==========================================
-- These functions are registered with redis.register_function()
-- and can be called via FCALL command from clients

-- Enqueue a new job
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: groupId, dataJson, maxAttempts, orderMs, delayUntil, jobId, keepCompleted,
--         clientTimestamp, orderingDelayMs, groupConfigJson
-- Returns: job data array or existing job ID if duplicate
local function enqueue(keys, args)
    local ns = keys[1]
    local groupId = args[1]
    local data = args[2]
    local maxAttempts = tonumber(args[3])
    local orderMs = tonumber(args[4])
    local delayUntil = tonumber(args[5])
    local jobId = args[6]
    local keepCompleted = tonumber(args[7]) or 0
    local clientTimestamp = tonumber(args[8])
    local orderingDelayMs = tonumber(args[9]) or 0
    local groupConfigJson = args[10]

    -- [新增逻辑]：原子性更新组配置
    if groupConfigJson and groupConfigJson ~= "" and groupConfigJson ~= "null" then
        local status, config = pcall(cjson.decode, groupConfigJson)
        if status and config then
            local configKey = ns .. ":config:" .. groupId
            local args_inner = {}
            for k, v in pairs(config) do
                if v ~= nil then
                    table.insert(args_inner, k)
                    table.insert(args_inner, tostring(v))
                end
            end
            if #args_inner > 0 then
                redis.call("HMSET", configKey, unpack(args_inner))
            end
        end
    end

    local readyKey = ns .. ":ready"
    local delayedKey = ns .. ":delayed"
    local limitedKey = ns .. ":limited"
    local stageKey = ns .. ":stage"
    local timerKey = ns .. ":stage:timer"
    local jobKey = ns .. ":job:" .. jobId
    local groupsKey = ns .. ":groups"

    -- Idempotence: ensure unique jobId per queue namespace with stale-key recovery
    local uniqueKey = ns .. ":unique:" .. jobId
    local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")
    if not uniqueSet then
        -- Duplicate detected. Check for stale unique mapping
        local exists = redis.call("EXISTS", jobKey)
        if exists == 0 then
            -- Job doesn't exist but unique key does (stale), clean up and proceed
            redis.call("DEL", uniqueKey)
            redis.call("SET", uniqueKey, jobId)
        else
            -- Job exists, check its status and location
            local gid = redis.call("HGET", jobKey, "groupId")
            local inProcessing = redis.call("ZSCORE", ns .. ":processing", jobId)
            local inDelayed = redis.call("ZSCORE", ns .. ":delayed", jobId)
            local inGroup = nil
            if gid then
                inGroup = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
            end
            if (not inProcessing) and (not inDelayed) and (not inGroup) then
                if keepCompleted == 0 then
                    redis.call("DEL", jobKey)
                    redis.call("DEL", uniqueKey)
                    redis.call("SET", uniqueKey, jobId)
                else
                    -- Job hash exists and we're keeping completed jobs, ensure unique key exists
                    redis.call("SET", uniqueKey, jobId)
                    return jobId
                end
            else
                if keepCompleted == 0 then
                    local jobStatus = redis.call("HGET", jobKey, "status")
                    if jobStatus == "completed" then
                        redis.call("DEL", jobKey)
                        redis.call("DEL", uniqueKey)
                        redis.call("SET", uniqueKey, jobId)
                    else
                        -- Job is still active, ensure unique key exists
                        redis.call("SET", uniqueKey, jobId)
                        return jobId
                    end
                end
                local activeAgain = redis.call("ZSCORE", ns .. ":processing", jobId)
                local delayedAgain = redis.call("ZSCORE", ns .. ":delayed", jobId)
                local inGroupAgain = nil
                if gid then
                    inGroupAgain = redis.call("ZSCORE", ns .. ":g:" .. gid, jobId)
                end
                local jobStillExists = redis.call("EXISTS", jobKey)
                if jobStillExists == 1 and (activeAgain or delayedAgain or inGroupAgain) then
                    return jobId
                end
            end
        end
    end

    local gZ = ns .. ":g:" .. groupId

    if not orderMs then
        orderMs = tonumber(redis.call("TIME")[1]) * 1000
    end
    local baseEpoch = 1704067200000
    local relativeMs = orderMs - baseEpoch

    -- Use date-based sequence key to auto-reset daily (prevents max int overflow)
    local daysSinceEpoch = math.floor(orderMs / 86400000)
    local seqKey = ns .. ":seq:" .. daysSinceEpoch
    local seq = redis.call("INCR", seqKey)
    local score = relativeMs * 1000 + seq

    -- Get Redis server time for buffering logic (to be consistent with server time)
    local timeResult = redis.call("TIME")
    local now = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

    -- Use client timestamp for the job hash so timing calculations are accurate from client perspective
    local timestamp = clientTimestamp or now

    redis.call("HMSET", jobKey,
        "id", jobId,
        "groupId", groupId,
        "data", data,
        "attempts", "0",
        "maxAttempts", tostring(maxAttempts),
        "seq", tostring(seq),
        "timestamp", tostring(timestamp),
        "orderMs", tostring(orderMs),
        "score", tostring(score),
        "delayUntil", tostring(delayUntil)
    )

    -- Track group membership (idempotent)
    redis.call("SADD", groupsKey, groupId)
    redis.call("HINCRBY", ns .. ":g:" .. groupId .. ":meta", "count", 1)

    -- Determine job status and placement
    local jobStatus = "waiting"

    if delayUntil > 0 and delayUntil > now then
        -- Job is delayed, add to delayed set ONLY (physical separation)
        redis.call("ZADD", delayedKey, delayUntil, jobId)
        jobStatus = "delayed"
        redis.call("HSET", jobKey, "status", jobStatus)
    elseif orderMs and orderingDelayMs > 0 then
        -- Job should be staged for ordering (orderMs provided and orderingDelayMs > 0)
        -- NOTE: Do NOT add to group ZSET yet - only to staging
        local releaseAt = orderMs + orderingDelayMs
        redis.call("ZADD", stageKey, releaseAt, jobId)
        jobStatus = "staged"
        redis.call("HSET", jobKey, "status", jobStatus)

        -- Update/set timer to earliest staged job
        local currentHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
        if currentHead and #currentHead >= 2 then
            local headReleaseAt = tonumber(currentHead[2])
            -- Set timer to expire when the earliest job is ready
            local ttlMs = math.max(1, headReleaseAt - now)
            redis.call("SET", timerKey, "1", "PX", ttlMs)
        end
    else
        -- Job is not delayed and not staged, add to group set and check concurrency
        redis.call("ZADD", gZ, score, jobId)
        jobStatus = "waiting"
        redis.call("HSET", jobKey, "status", jobStatus)

        -- Use helper to update group status
        updateGroupQueueStatus(ns, groupId)
    end

    -- Return job data to avoid race condition where job might be processed & cleaned up
    -- before getJob() is called
    return {jobId, groupId, data, "0", tostring(maxAttempts), tostring(timestamp), tostring(orderMs), tostring(delayUntil), jobStatus}
end

-- Complete a job with metadata
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, groupId, status, timestamp, resultOrError, keepCompleted, keepFailed,
--         processedOn, finishedOn, attempts, maxAttempts, token
-- Returns: 1 if successful, 0 if failed
local function completeWithMetadata(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local gid = args[2]
    local status = args[3]
    local timestamp = tonumber(args[4])
    local resultOrError = args[5]
    local keepCompleted = tonumber(args[6])
    local keepFailed = tonumber(args[7])
    local processedOn = args[8]
    local finishedOn = args[9]
    local attempts = args[10]
    local maxAttempts = args[11]
    local token = args[12]

    local jobKey = ns .. ":job:" .. jobId
    local processingKey = ns .. ":processing"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Get parentId before potentially deleting the job
    local parentId = redis.call("HGET", jobKey, "parentId")

    -- Part 1: Atomically verify and mark completion (prevent duplicate processing)
    local jobStatus = redis.call("HGET", jobKey, "status")
    local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

    -- If job is not in "processing" state OR not in processing set, this is late/duplicate
    if jobStatus ~= "processing" or not stillInProcessing then
        -- Job was already handled (recovered, failed, or completed by another worker)
        -- Return 0 to indicate this completion was ignored
        return 0
    end

    -- Token verification
    local procKey = ns .. ":processing:" .. jobId
    local storedToken = redis.call("HGET", procKey, "token")

    -- If processing key doesn't exist (already deleted) or token doesn't match
    if not storedToken or storedToken ~= token then
        return 0
    end

    -- Atomically mark as completed and remove from processing
    redis.call("HSET", jobKey, "status", "completing") -- Temporary status to block stalled checker
    redis.call("DEL", procKey)
    redis.call("ZREM", processingKey, jobId)

    -- Always remove this job from active list to prevent stale entries
    local groupActiveKey = ns .. ":g:" .. gid .. ":active"
    local activeJobId = redis.call("LINDEX", groupActiveKey, 0)
    local wasActive = (activeJobId == jobId)

    if wasActive then
        -- Normal case: remove from head of active list
        redis.call("LPOP", groupActiveKey)
    else
        -- Race condition: not at head, but still remove to prevent stale entries
        redis.call("LREM", groupActiveKey, 1, jobId)
    end

    -- [PHYSICAL SEPARATION] Decrement group job count
    local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
    local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

    -- Check if there are more jobs in this group
    local gZ = ns .. ":g:" .. gid
    local jobCount = redis.call("ZCARD", gZ)
    if jobCount == 0 then
        -- Clean up empty group ONLY if no jobs left in any state
        if remainingJobs <= 0 then
            redis.call("DEL", gZ)
            redis.call("DEL", groupActiveKey)
            redis.call("DEL", groupMetaKey)
            redis.call("SREM", ns .. ":groups", gid)
            redis.call("ZREM", ns .. ":ready", gid)
            redis.call("ZREM", limitedKey, gid)
            redis.call("DEL", ns .. ":buffer:" .. gid)
            redis.call("ZREM", ns .. ":buffering", gid)
        else
            -- Group still has delayed/staged jobs, just remove from ready/limited
            redis.call("ZREM", readyKey, gid)
            redis.call("ZREM", limitedKey, gid)
        end
    else
        -- Group has more jobs, update ready/limited status based on activeCount
        local groupBufferKey = ns .. ":buffer:" .. gid
        local isBuffering = redis.call("EXISTS", groupBufferKey)

        if isBuffering == 0 then
            local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if nextHead and #nextHead >= 2 then
                local nextScore = tonumber(nextHead[2])
                local limit = getGroupLimit(ns, gid)
                local currentActive = redis.call("LLEN", groupActiveKey)

                -- [LIMITED GROUP SET] Check if we can move from limited to ready
                if currentActive < limit then
                    redis.call("ZREM", limitedKey, gid)
                    redis.call("ZADD", readyKey, nextScore, gid)
                elseif currentActive >= limit and redis.call("ZSCORE", readyKey, gid) then
                    -- Group is now full, move from ready to limited
                    redis.call("ZREM", readyKey, gid)
                    redis.call("ZADD", limitedKey, nextScore, gid)
                end
            end
        end
    end

    -- Update Flow Parent if exists
    if parentId then
        updateParentFlow(ns, jobId, parentId, status, resultOrError, timestamp)
    end

    -- Part 2: Record job metadata (completed or failed)
    if status == "completed" then
        local completedKey = ns .. ":completed"

        -- CRITICAL: Always set final status first, even if job will be deleted
        redis.call("HSET", jobKey, "status", "completed")

        if keepCompleted > 0 then
            -- Store full job metadata and add to completed set
            redis.call("HSET", jobKey,
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts,
                "returnvalue", resultOrError
            )
            redis.call("ZADD", completedKey, timestamp, jobId)

            -- Trim old entries atomically
            trimCompleted(ns, keepCompleted)
        else
            -- keepCompleted == 0: Delete immediately
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. jobId)
            redis.call("DEL", ns .. ":flow:results:" .. jobId)
        end

    elseif status == "failed" then
        local failedKey = ns .. ":failed"
        local errorInfo = cjson.decode(resultOrError)

        -- CRITICAL: Always set final status first, even if job will be deleted
        redis.call("HSET", jobKey, "status", "failed")

        if keepFailed > 0 then
            redis.call("HSET", jobKey,
                "failedReason", errorInfo.message or "Error",
                "failedName", errorInfo.name or "Error",
                "stacktrace", errorInfo.stack or "",
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts
            )
            redis.call("ZADD", failedKey, timestamp, jobId)
        else
            -- Delete job
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. jobId)
            redis.call("DEL", ns .. ":flow:results:" .. jobId)
        end
    end

    -- Publish completion/failure event for waiters
    local eventPayload = cjson.encode({
        id = jobId,
        status = status,
        result = resultOrError
    })
    redis.call("PUBLISH", ns .. ":events", eventPayload)

    return 1
end

-- Reserve a job from the ready queue for processing
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: nowEpochMs, vtMs, scanLimit, token
-- Returns: job data string or nil if no job available
local function reserve(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])
    local vt = tonumber(args[2])
    local scanLimit = tonumber(args[3]) or 20
    local token = args[4]

    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Respect paused state
    if redis.call("GET", ns .. ":paused") then
        return nil
    end

    -- STALLED JOB RECOVERY WITH THROTTLING
    local processingKey = ns .. ":processing"
    local stalledCheckKey = ns .. ":stalled:lastcheck"
    local lastCheck = tonumber(redis.call("GET", stalledCheckKey)) or 0
    local stalledCheckInterval = math.min(math.floor(vt / 4), 5000)

    local shouldCheckStalled = (now - lastCheck) >= stalledCheckInterval

    -- Get available groups
    local groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")

    -- Check for stalled jobs if: queue is empty OR it's time for periodic check
    if (not groups or #groups == 0) or shouldCheckStalled then
        if shouldCheckStalled then
            redis.call("SET", stalledCheckKey, tostring(now))
        end

        local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
        for _, jobId in ipairs(expiredJobs) do
            local procKey = ns .. ":processing:" .. jobId
            local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
            local gid = procData[1]
            local deadlineAt = tonumber(procData[2])
            if gid and deadlineAt and now > deadlineAt then
                local jobKey = ns .. ":job:" .. jobId
                local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
                local jobScore = tonumber(jobData[1])
                local delayUntil = tonumber(jobData[2] or "0")

                if jobScore then
                    local gZ = ns .. ":g:" .. gid

                    if delayUntil > 0 and delayUntil > now then
                        -- Job is still delayed, add to delayed set ONLY
                        redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
                        redis.call("HSET", jobKey, "status", "delayed")

                        -- Update group status in ready/limited (it might have been the head)
                        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                        if head and #head >= 2 then
                            local headScore = tonumber(head[2])
                            if redis.call("ZSCORE", readyKey, gid) then
                                redis.call("ZADD", readyKey, headScore, gid)
                            elseif redis.call("ZSCORE", limitedKey, gid) then
                                redis.call("ZADD", limitedKey, headScore, gid)
                            end
                        end
                    else
                        -- Recover to waiting state
                        redis.call("ZADD", gZ, jobScore, jobId)
                        redis.call("HSET", jobKey, "status", "waiting")

                        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                        if head and #head >= 2 then
                            local headScore = tonumber(head[2])
                            -- [LIMITED GROUP SET] Check group capacity after stalled recovery
                            local groupActiveKey = ns .. ":g:" .. gid .. ":active"
                            local limit = getGroupLimit(ns, gid)
                            local currentActive = redis.call("LLEN", groupActiveKey)

                            if currentActive >= limit then
                                -- Group is still full, add to limited instead of ready
                                redis.call("ZREM", readyKey, gid)
                                redis.call("ZADD", limitedKey, headScore, gid)
                            else
                                -- Group has capacity, add to ready
                                redis.call("ZREM", limitedKey, gid)
                                redis.call("ZADD", readyKey, headScore, gid)
                            end
                        end
                    end
                    -- [FIX] Remove from active list to prevent ghost concurrency
                    redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
                    redis.call("DEL", ns .. ":lock:" .. gid)
                    redis.call("DEL", procKey)
                    redis.call("ZREM", processingKey, jobId)
                end
            end
        end

        -- Refresh groups after recovery (only if we didn't have any before)
        if not groups or #groups == 0 then
            groups = redis.call("ZRANGE", readyKey, 0, scanLimit - 1, "WITHSCORES")
        end
    end

    if not groups or #groups == 0 then
        return nil
    end

    local chosenGid = nil
    local chosenIndex = nil
    local headJobId = nil
    local job = nil

    -- Try to atomically acquire a group and its head job
    local processedCount = 0
    local maxProcessed = scanLimit * 2  -- Process up to 2x scanLimit groups to handle full ones

    for i = 1, #groups, 2 do
        if processedCount >= maxProcessed then
            break  -- Safety: don't process too many groups in one call
        end

        local gid = groups[i]
        local gZ = ns .. ":g:" .. gid
        local groupActiveKey = ns .. ":g:" .. gid .. ":active"

        -- Check concurrency limit
        local activeCount = redis.call("LLEN", groupActiveKey)
        local limit = getGroupLimit(ns, gid)

        -- [LAZY CLEANUP START: Clean up ghost tasks from active list]
        -- Only trigger cleanup when activeCount >= limit to avoid performance impact on happy path
        if activeCount >= limit then
            local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
            local prunedCount = 0

            for _, jobId in ipairs(activeJobs) do
                -- Validate against processing ZSET as the authoritative source
                local score = redis.call("ZSCORE", processingKey, jobId)
                if not score then
                    -- Found a ghost task - remove it immediately
                    redis.call("LREM", groupActiveKey, 0, jobId)
                    prunedCount = prunedCount + 1
                end
            end

            -- Adjust activeCount if we pruned ghost tasks
            if prunedCount > 0 then
                activeCount = math.max(0, activeCount - prunedCount)
            end
        end
        -- [LAZY CLEANUP END]

        if activeCount < limit then
            -- Group has capacity, try to get head job
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local candidateJobId = head[1]
                local headJobKey = ns .. ":job:" .. candidateJobId

                -- Pop the job and push to active list atomically
                local zpop = redis.call("ZPOPMIN", gZ, 1)
                if zpop and #zpop > 0 then
                    headJobId = zpop[1]
                    -- Read the popped job (use headJobId to avoid races)
                    headJobKey = ns .. ":job:" .. headJobId
                    job = redis.call("HMGET", headJobKey, "id", "groupId", "data", "attempts", "maxAttempts", "seq", "timestamp", "orderMs", "score", "isFlowParent")

                    -- Push to group active list
                    redis.call("LPUSH", groupActiveKey, headJobId)

                    chosenGid = gid
                    chosenIndex = (i + 1) / 2 - 1
                    -- Mark job as processing for accurate stalled detection and idempotency
                    redis.call("HSET", headJobKey, "status", "processing")
                    break
                end
            end
        else
            -- Group is full, move to limited if it has waiting tasks
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headScore = tonumber(head[2])
                if redis.call("ZCARD", gZ) > 0 then
                    redis.call("ZREM", readyKey, gid)
                    redis.call("ZADD", limitedKey, headScore, gid)
                end
            end
        end

        processedCount = processedCount + 1
    end

    if not chosenGid or not job then
        return nil
    end

    local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9]

    -- Validate job data exists (handle corrupted/missing job hash)
    if not id or id == false then
        -- Job hash is missing/corrupted, clean up group active list
        local groupActiveKey = ns .. ":g:" .. chosenGid .. ":active"
        redis.call("LREM", groupActiveKey, 1, headJobId)

        -- Re-add next job to ready queue if exists
        local gZ = ns .. ":g:" .. chosenGid
        local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if nextHead and #nextHead >= 2 then
            local nextScore = tonumber(nextHead[2])
            redis.call("ZADD", readyKey, nextScore, chosenGid)
        end

        return nil
    end

    -- Remove the group from ready queue
    redis.call("ZREMRANGEBYRANK", readyKey, chosenIndex, chosenIndex)

    local procKey = ns .. ":processing:" .. id
    local deadline = now + vt
    redis.call("HSET", procKey,
        "groupId", chosenGid,
        "deadlineAt", tostring(deadline),
        "token", token)

    redis.call("ZADD", processingKey, deadline, id)

    -- [LIMITED GROUP SET] Update ready/limited status
    local groupActiveKey = ns .. ":g:" .. chosenGid .. ":active"
    local limit = getGroupLimit(ns, chosenGid)
    local currentActive = redis.call("LLEN", groupActiveKey)

    local gZ = ns .. ":g:" .. chosenGid
    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
        local nextScore = tonumber(nextHead[2])
        if currentActive < limit then
            redis.call("ZADD", readyKey, nextScore, chosenGid)
        else
            redis.call("ZADD", limitedKey, nextScore, chosenGid)
        end
    end

    local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]
    return id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. token
end

-- Retry a job
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, backoffMs, token
-- Returns: attempts count if successful, -1 if max attempts reached, -2 if token mismatch
local function retry(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local backoffMs = tonumber(args[2]) or 0
    local token = args[3]

    local jobKey = ns .. ":job:" .. jobId
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Token verification
    local procKey = ns .. ":processing:" .. jobId
    local storedToken = redis.call("HGET", procKey, "token")

    -- If job still has a lock (processing) and token doesn't match, reject retry
    if storedToken and storedToken ~= token then
        return -2 -- LockLost: another worker is processing this job
    end
    -- If no stored token but token was provided, also reject (safety: prevent retry on recovered jobs)
    if not storedToken and token then
        return -2 -- LockLost: job was recovered/cleared, token is stale
    end

    local gid = redis.call("HGET", jobKey, "groupId")
    local attempts = tonumber(redis.call("HINCRBY", jobKey, "attempts", 1))
    local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts"))

    -- [CRITICAL FIX 1]: Check limits BEFORE deleting the lock.
    -- If we return -1, we MUST preserve the lock/token so that recordFinalFailure
    -- (called next by the worker) can pass its token verification.
    -- [CRITICAL FIX 2]: Use >= instead of >. If attempts reaches max, we stop.
    if attempts >= maxAttempts then
        return -1
    end

    -- Only delete lock if we are actually queuing for retry (releasing to pool)
    redis.call("DEL", procKey)
    redis.call("ZREM", ns .. ":processing", jobId)

    -- BullMQ-style: Remove from group active list
    local groupActiveKey = ns .. ":g:" .. gid .. ":active"
    redis.call("LREM", groupActiveKey, 1, jobId)

    local score = tonumber(redis.call("HGET", jobKey, "score"))
    local gZ = ns .. ":g:" .. gid

    -- If backoffMs > 0, delay the retry
    if backoffMs > 0 then
        local now = tonumber(redis.call("TIME")[1]) * 1000
        local delayUntil = now + backoffMs

        -- Move to delayed set ONLY (physical separation)
        local delayedKey = ns .. ":delayed"
        redis.call("ZADD", delayedKey, delayUntil, jobId)
        redis.call("HSET", jobKey, "runAt", tostring(delayUntil), "status", "delayed", "delayUntil", tostring(delayUntil))

        -- Ensure it's NOT in group ZSET
        redis.call("ZREM", gZ, jobId)

        -- If group is now empty, remove from ready/limited
        local jobCount = redis.call("ZCARD", gZ)
        if jobCount == 0 then
            redis.call("ZREM", readyKey, gid)
            redis.call("ZREM", limitedKey, gid)
        else
            -- Update group score in ready/limited if it was the head
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headScore = tonumber(head[2])
                if redis.call("ZSCORE", readyKey, gid) then
                    redis.call("ZADD", readyKey, headScore, gid)
                elseif redis.call("ZSCORE", limitedKey, gid) then
                    redis.call("ZADD", limitedKey, headScore, gid)
                end
            end
        end
    else
        -- No backoff - immediate retry, add back to group ZSET
        redis.call("ZADD", gZ, score, jobId)
        redis.call("HSET", jobKey, "status", "waiting")
        redis.call("HDEL", jobKey, "runAt", "delayUntil")

        -- [LIMITED GROUP SET] Check if group is full and update ready/limited accordingly
        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headScore = tonumber(head[2])
            local limit = getGroupLimit(ns, gid)
            local currentActive = redis.call("LLEN", groupActiveKey)

            if currentActive >= limit then
                -- Group is full, move to limited
                redis.call("ZREM", readyKey, gid)
                redis.call("ZADD", limitedKey, headScore, gid)
            else
                -- Group has slots, move to ready
                redis.call("ZREM", limitedKey, gid)
                redis.call("ZADD", readyKey, headScore, gid)
            end
        end
    end

    return attempts
end

-- Extend the job processing deadline (heartbeat)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, groupId, extendMs, token
-- Returns: 1 if successful, 0 if failed
local function heartbeat(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local gid = args[2]
    local extendMs = tonumber(args[3])
    local token = args[4]

    -- BullMQ-style: only extend processing deadline, no group lock
    local procKey = ns .. ":processing:" .. jobId
    -- Token verification
    local storedToken = redis.call("HGET", procKey, "token")

    if storedToken and storedToken == token then
        local now = tonumber(redis.call("TIME")[1]) * 1000
        local newDeadline = now + extendMs
        redis.call("HSET", procKey, "deadlineAt", tostring(newDeadline))

        -- Also update the processing ZSET score
        local processingKey = ns .. ":processing"
        redis.call("ZADD", processingKey, newDeadline, jobId)
        return 1
    else
        -- Token mismatch or key missing (stalled)
        return 0
    end
end

-- Promote delayed jobs to waiting state
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now
-- Returns: count of promoted jobs
local function promoteDelayedJobs(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])

    local delayedKey = ns .. ":delayed"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    local promotedCount = 0

    -- Get jobs that are ready (score <= now)
    local readyJobs = redis.call("ZRANGEBYSCORE", delayedKey, 0, now)

    for i = 1, #readyJobs do
        local jobId = readyJobs[i]
        local jobKey = ns .. ":job:" .. jobId
        local groupId = redis.call("HGET", jobKey, "groupId")

        if groupId then
            local gZ = ns .. ":g:" .. groupId

            -- Remove from delayed set
            redis.call("ZREM", delayedKey, jobId)

            -- [PHYSICAL SEPARATION] Add back to group ZSET with original score
            local score = tonumber(redis.call("HGET", jobKey, "score"))
            if score then
                redis.call("ZADD", gZ, score, jobId)
                redis.call("SADD", ns .. ":groups", groupId)
                redis.call("HSET", jobKey, "status", "waiting")
                redis.call("HDEL", jobKey, "delayUntil", "runAt")

                -- Check if this job is now the head of its group (earliest in group)
                local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                if head and #head >= 2 then
                    local headJobId = head[1]
                    local headScore = tonumber(head[2])

                    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
                    local limit = getGroupLimit(ns, groupId)
                    local currentActive = redis.call("LLEN", groupActiveKey)

                    -- [LIMITED GROUP SET] Check group capacity
                    if currentActive >= limit then
                        -- Group is full, move to limited
                        redis.call("ZREM", readyKey, groupId)
                        redis.call("ZADD", limitedKey, headScore, groupId)
                    else
                        -- Group has slots, move to ready
                        redis.call("ZREM", limitedKey, groupId)
                        redis.call("ZADD", readyKey, headScore, groupId)
                    end
                    promotedCount = promotedCount + 1
                end
            end
        end
    end

    return promotedCount
end

-- Mark job as dead-letter (failed permanently)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, groupId, token
-- Returns: 1 if successful, 0 if failed
local function deadLetter(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local groupId = args[2]
    local token = args[3]

    local gZ = ns .. ":g:" .. groupId
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    local jobKey = ns .. ":job:" .. jobId

    -- Token verification: Ensure only the correct worker can dead-letter the job
    local procKey = ns .. ":processing:" .. jobId
    local storedToken = redis.call("HGET", procKey, "token")

    -- If job still has a lock (processing) and token doesn't match, reject dead-letter
    if storedToken and storedToken ~= token then
        return 0 -- Lock mismatch: another worker is processing this job
    end
    -- If no stored token but token was provided, also reject (safety: prevent dead-lettering recovered jobs)
    if not storedToken and token then
        return 0
    end

    -- Remove job from group
    redis.call("ZREM", gZ, jobId)
    redis.call("ZREM", ns .. ":delayed", jobId)

    -- [PHYSICAL SEPARATION] Decrement group job count
    local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
    local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

    -- Remove from processing if it's there
    redis.call("DEL", procKey)
    redis.call("ZREM", ns .. ":processing", jobId)

    -- Remove idempotence mapping to allow reuse
    redis.call("DEL", ns .. ":unique:" .. jobId)

    -- BullMQ-style: Remove from group active list if present
    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
    redis.call("LREM", groupActiveKey, 1, jobId)

    -- Check if group is now empty or should be removed from ready queue
    if remainingJobs <= 0 then
        -- Group is empty, remove from ready and limited queues and clean up
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZREM", limitedKey, groupId)
        redis.call("DEL", gZ)
        redis.call("DEL", groupMetaKey)
        redis.call("DEL", groupActiveKey)
        redis.call("SREM", ns .. ":groups", groupId)
    else
        -- Group still has jobs, check if it can go to ready or should stay in limited
        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headScore = tonumber(head[2])
            local currentActive = redis.call("LLEN", groupActiveKey)
            local limit = getGroupLimit(ns, groupId)

            -- [LIMITED GROUP SET] Check if we can move from limited to ready
            if currentActive < limit then
                redis.call("ZREM", limitedKey, groupId)
                redis.call("ZADD", readyKey, headScore, groupId)
            elseif currentActive >= limit then
                -- Still full, ensure in limited
                redis.call("ZREM", readyKey, groupId)
                redis.call("ZADD", limitedKey, headScore, groupId)
            else
                -- Fallback: add to ready
                redis.call("ZADD", readyKey, headScore, groupId)
            end
        end
    end

    return 1
end

-- Clean up stalled jobs in processing queue
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now
-- Returns: count of cleaned jobs
local function cleanup(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])

    local readyKey = ns .. ":ready"
    local processingKey = ns .. ":processing"
    local cleaned = 0

    local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
    for _, jobId in ipairs(expiredJobs) do
        -- CRITICAL: Verify job is STILL in processing to avoid race conditions
        -- If job was completed between our snapshot and now, don't re-add it
        local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)

        if stillInProcessing then
            local procKey = ns .. ":processing:" .. jobId
            local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
            local gid = procData[1]
            local deadlineAt = tonumber(procData[2])
            if gid and deadlineAt and now > deadlineAt then
                local jobKey = ns .. ":job:" .. jobId
                local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
                local jobScore = tonumber(jobData[1])
                local delayUntil = tonumber(jobData[2]) or 0

                if jobScore then
                    local gZ = ns .. ":g:" .. gid
                    if delayUntil > now then
                        -- Recover to delayed state
                        redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
                        redis.call("HSET", jobKey, "status", "delayed")
                        -- [PHYSICAL SEPARATION] Ensure it's NOT in gZ
                        redis.call("ZREM", gZ, jobId)
                    else
                        -- Recover to waiting state
                        redis.call("ZADD", gZ, jobScore, jobId)
                        redis.call("HSET", jobKey, "status", "waiting")

                        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                        if head and #head >= 2 then
                            local headScore = tonumber(head[2])
                            -- [LIMITED GROUP SET] Check group capacity after recovery
                            local groupActiveKey = ns .. ":g:" .. gid .. ":active"
                            local limit = getGroupLimit(ns, gid)
                            local currentActive = redis.call("LLEN", groupActiveKey)

                            if currentActive >= limit then
                                redis.call("ZREM", readyKey, gid)
                                redis.call("ZADD", ns .. ":limited", headScore, gid)
                            else
                                redis.call("ZREM", ns .. ":limited", gid)
                                redis.call("ZADD", readyKey, headScore, gid)
                            end
                        end
                    end
                    -- [FIX] Remove from active list to prevent ghost concurrency
                    redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
                    redis.call("DEL", ns .. ":lock:" .. gid)
                    redis.call("DEL", procKey)
                    redis.call("ZREM", processingKey, jobId)

                    cleaned = cleaned + 1
                end
            end
        end
        -- If not still in processing, it was completed - don't re-add it!
    end

    return cleaned
end

-- Remove a job completely from the queue
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId
-- Returns: 1 if successful, 0 if job not found
local function remove(keys, args)
    local ns = keys[1]
    local jobId = args[1]

    local jobKey = ns .. ":job:" .. jobId
    local delayedKey = ns .. ":delayed"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"
    local processingKey = ns .. ":processing"

    -- If job does not exist, return 0
    if redis.call("EXISTS", jobKey) == 0 then
        return 0
    end

    local jobData = redis.call("HMGET", jobKey, "groupId", "parentId", "status")
    local groupId = jobData[1]
    local parentId = jobData[2]
    local status = jobData[3]

    -- Remove from delayed and processing structures
    redis.call("ZREM", delayedKey, jobId)
    redis.call("DEL", ns .. ":processing:" .. jobId)
    redis.call("ZREM", processingKey, jobId)

    -- Remove from completed/failed retention sets if present
    redis.call("ZREM", ns .. ":completed", jobId)
    redis.call("ZREM", ns .. ":failed", jobId)

    -- Delete idempotence mapping
    redis.call("DEL", ns .. ":unique:" .. jobId)

    -- If we have a group, update group zset and ready queue accordingly
    if groupId then
        local gZ = ns .. ":g:" .. groupId
        local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
        redis.call("ZREM", gZ, jobId)

        -- [FIX] Remove from active list to prevent ghost concurrency
        redis.call("LREM", groupActiveKey, 1, jobId)

        -- [PHYSICAL SEPARATION] Decrement group job count ONLY if it was in an active state
        local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
        local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0

        if status ~= "completed" and status ~= "failed" then
            remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
        end

        if remainingJobs <= 0 then
            redis.call("ZREM", readyKey, groupId)
            redis.call("ZREM", limitedKey, groupId)
            -- Clean up empty group
            redis.call("DEL", gZ)
            redis.call("DEL", groupActiveKey)
            redis.call("DEL", groupMetaKey)
            redis.call("SREM", ns .. ":groups", groupId)
        else
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headScore = tonumber(head[2])
                local limit = getGroupLimit(ns, groupId)
                local currentActive = redis.call("LLEN", groupActiveKey)

                -- [LIMITED GROUP SET] Check group's current queue position and update accordingly
                if currentActive >= limit then
                    -- Group is still full, keep it in limited (or add to limited)
                    redis.call("ZREM", readyKey, groupId)
                    redis.call("ZADD", limitedKey, headScore, groupId)
                else
                    -- Group has capacity now, move to ready
                    redis.call("ZREM", limitedKey, groupId)
                    redis.call("ZADD", readyKey, headScore, groupId)
                end
            end
        end
    end

    -- Finally, delete the job hash, flow results and children tracking
    redis.call("DEL",
        jobKey,
        ns .. ":flow:results:" .. jobId,
        ns .. ":flow:children:" .. jobId
    )

    -- Clean up flow relationships
    -- If this job is a child, remove it from parent's children set
    if parentId then
        local parentKey = ns .. ":job:" .. parentId
        local parentChildrenKey = ns .. ":flow:children:" .. parentId

        -- Only act if we actually removed membership (idempotent / avoids double-decrement)
        local removedFromSet = redis.call("SREM", parentChildrenKey, jobId)
        if removedFromSet == 1 then
            -- Also remove any recorded child result on parent (avoid stale childrenValues entries)
            redis.call("HDEL", ns .. ":flow:results:" .. parentId, jobId)

            -- Decrement remaining counter
            local remaining = redis.call("HINCRBY", parentKey, "flowRemaining", -1)

            -- If all children are now done, possibly activate parent
            if remaining <= 0 then
                local parentStatus = redis.call("HGET", parentKey, "status")
                if parentStatus == "waiting-children" then
                    redis.call("HSET", parentKey, "status", "waiting")

                    local parentGroupId = redis.call("HGET", parentKey, "groupId")
                    local parentScore = tonumber(redis.call("HGET", parentKey, "score"))
                    if not parentScore then
                        parentScore = tonumber(redis.call("TIME")[1]) * 1000
                    end

                    local pGZ = ns .. ":g:" .. parentGroupId
                    redis.call("ZADD", pGZ, parentScore, parentId)
                    redis.call("SADD", ns .. ":groups", parentGroupId)

                    -- Update parent group status
                    updateGroupQueueStatus(ns, parentGroupId)
                end
            end
        end
    end

    return 1
end

-- Check if queue is completely empty
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: 1 if empty, 0 if not empty
local function isEmpty(keys, args)
    local ns = keys[1]

    -- Check processing jobs
    local processingCount = redis.call("ZCARD", ns .. ":processing")
    if processingCount > 0 then
        return 0
    end

    -- Check delayed jobs
    local delayedCount = redis.call("ZCARD", ns .. ":delayed")
    if delayedCount > 0 then
        return 0
    end

    -- Check ready groups (jobs waiting)
    local readyCount = redis.call("ZCARD", ns .. ":ready")
    if readyCount > 0 then
        return 0
    end

    -- Check all groups for waiting jobs
    local groups = redis.call("SMEMBERS", ns .. ":groups")
    for _, gid in ipairs(groups) do
        local gZ = ns .. ":g:" .. gid
        local jobCount = redis.call("ZCARD", gZ)
        if jobCount > 0 then
            return 0
        end
    end

    -- Queue is completely empty
    return 1
end

-- Get active job count
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: count of active jobs
local function getActiveCount(keys, args)
    local ns = keys[1]
    local processingKey = ns .. ":processing"
    return redis.call("ZCARD", processingKey)
end

-- Get waiting job count
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: count of waiting jobs
local function getWaitingCount(keys, args)
    local ns = keys[1]
    local groupsKey = ns .. ":groups"
    local groupIds = redis.call("SMEMBERS", groupsKey)
    local total = 0
    for _, gid in ipairs(groupIds) do
        local gk = ns .. ":g:" .. gid
        total = total + (redis.call("ZCARD", gk) or 0)
    end
    return total
end

-- Get delayed job count
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: count of delayed jobs
local function getDelayedCount(keys, args)
    local ns = keys[1]
    local delayedKey = ns .. ":delayed"
    return redis.call("ZCARD", delayedKey)
end

-- Get all active job IDs
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: array of active job IDs
local function getActiveJobs(keys, args)
    local ns = keys[1]
    local processingKey = ns .. ":processing"
    return redis.call("ZRANGE", processingKey, 0, -1)
end

-- Get all delayed job IDs
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: array of delayed job IDs
local function getDelayedJobs(keys, args)
    local ns = keys[1]
    local delayedKey = ns .. ":delayed"
    return redis.call("ZRANGE", delayedKey, 0, -1)
end

-- Get all unique group IDs
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: array of group IDs
local function getUniqueGroups(keys, args)
    local ns = keys[1]
    local groupsKey = ns .. ":groups"
    return redis.call("SMEMBERS", groupsKey)
end

-- Get unique group count
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: count of unique groups
local function getUniqueGroupsCount(keys, args)
    local ns = keys[1]
    local groupsKey = ns .. ":groups"
    return redis.call("SCARD", groupsKey)
end

-- Get all waiting job IDs from all groups
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: array of waiting job IDs
local function getWaitingJobs(keys, args)
    local ns = keys[1]
    local groupsKey = ns .. ":groups"
    local groupIds = redis.call("SMEMBERS", groupsKey)
    local jobs = {}
    for _, gid in ipairs(groupIds) do
        local gZ = ns .. ":g:" .. gid
        local groupJobs = redis.call("ZRANGE", gZ, 0, -1)
        for _, jobId in ipairs(groupJobs) do
            table.insert(jobs, jobId)
        end
    end
    return jobs
end

-- Batch enqueue multiple jobs
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobsJson, keepCompleted, clientTimestamp, orderingDelayMs
-- Returns: array of job data
local function enqueueBatch(keys, args)
    local ns = keys[1]
    local jobsJson = args[1]
    local keepCompleted = tonumber(args[2]) or 0
    local clientTimestamp = tonumber(args[3])
    local orderingDelayMs = tonumber(args[4]) or 0

    local jobs = cjson.decode(jobsJson)

    -- Get Redis server time
    local timeResult = redis.call("TIME")
    local now = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

    -- Keys
    local stageKey = ns .. ":stage"
    local readyKey = ns .. ":ready"
    local delayedKey = ns .. ":delayed"
    local groupsKey = ns .. ":groups"
    local limitedKey = ns .. ":limited"
    local timerKey = ns .. ":stage:timer"

    local baseEpoch = 1704067200000
    local daysSinceEpoch = math.floor(clientTimestamp / 86400000)
    local seqKey = ns .. ":seq:" .. daysSinceEpoch

    -- Track groups that need ready queue updates
    local groupsToUpdate = {}
    local results = {}

    -- Process all jobs in batch
    for i, job in ipairs(jobs) do
        local jobId = job.jobId
        local groupId = job.groupId
        local data = job.data
        local maxAttempts = tonumber(job.maxAttempts)
        local orderMs = tonumber(job.orderMs) or clientTimestamp
        local delayUntil = job.delayMs and (now + tonumber(job.delayMs)) or 0

        -- Idempotence check
        local uniqueKey = ns .. ":unique:" .. jobId
        local uniqueSet = redis.call("SET", uniqueKey, jobId, "NX")

        if uniqueSet then
            -- Generate sequence and score
            local seq = redis.call("INCR", seqKey)
            local relativeMs = orderMs - baseEpoch
            local score = relativeMs * 1000 + seq

            -- Create job hash
            local jobKey = ns .. ":job:" .. jobId
            redis.call("HMSET", jobKey,
                "id", jobId,
                "groupId", groupId,
                "data", data,
                "attempts", "0",
                "maxAttempts", tostring(maxAttempts),
                "seq", tostring(seq),
                "timestamp", tostring(clientTimestamp),
                "orderMs", tostring(orderMs),
                "score", tostring(score),
                "delayUntil", tostring(delayUntil)
            )

            -- Add to groups set
            redis.call("SADD", groupsKey, groupId)
            redis.call("HINCRBY", ns .. ":g:" .. groupId .. ":meta", "count", 1)

            local gZ = ns .. ":g:" .. groupId

            -- Determine job placement
            local jobStatus = "waiting"

            if delayUntil > 0 and delayUntil > now then
                -- Delayed job: add to delayed set ONLY
                redis.call("ZADD", delayedKey, delayUntil, jobId)
                jobStatus = "delayed"
                redis.call("HSET", jobKey, "status", jobStatus)
            elseif orderMs and orderingDelayMs > 0 then
                -- Staged job (ordering): add to stage set ONLY
                local releaseAt = orderMs + orderingDelayMs
                redis.call("ZADD", stageKey, releaseAt, jobId)
                jobStatus = "staged"
                redis.call("HSET", jobKey, "status", jobStatus)
            else
                -- Ready to process: add to group ZSET
                redis.call("ZADD", gZ, score, jobId)
                jobStatus = "waiting"
                redis.call("HSET", jobKey, "status", jobStatus)
                -- Mark group for ready queue update (batch later)
                groupsToUpdate[groupId] = true
            end

            -- Store job metadata to return
            table.insert(results, {
                jobId,
                groupId,
                data,
                "0", -- attempts
                tostring(maxAttempts),
                tostring(clientTimestamp),
                tostring(orderMs),
                tostring(delayUntil),
                jobStatus,
            })
        else
            -- Job ID already exists (idempotence) - fetch existing job data
            local jobKey = ns .. ":job:" .. jobId
            local jobData = redis.call("HMGET", jobKey, "id", "groupId", "data", "attempts", "maxAttempts", "timestamp", "orderMs", "delayUntil", "status")
            if jobData[1] then
                table.insert(results, jobData)
            else
                -- Shouldn't happen but handle gracefully
                table.insert(results, {
                    jobId,
                    groupId,
                    data,
                    "0",
                    tostring(maxAttempts),
                    tostring(clientTimestamp),
                    tostring(orderMs),
                    tostring(delayUntil),
                    "waiting",
                })
            end
        end
    end

    -- Batch update ready queue for all affected groups
    for groupId, _ in pairs(groupsToUpdate) do
        local gZ = ns .. ":g:" .. groupId
        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headScore = tonumber(head[2])

            -- [LIMITED GROUP SET] Check if group is already in limited
            local isLimited = redis.call("ZSCORE", limitedKey, groupId)

            if isLimited then
                -- Group already in limited, don't move it to ready
            else
                -- Group not in limited, check capacity
                local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
                local limit = getGroupLimit(ns, groupId)
                local currentActive = redis.call("LLEN", groupActiveKey)

                if currentActive >= limit then
                    -- Group is full, add to limited
                    redis.call("ZADD", limitedKey, headScore, groupId)
                else
                    -- Group has capacity, add to ready
                    redis.call("ZADD", readyKey, headScore, groupId)
                end
            end
        end
    end

    -- Update staging timer if needed
    if orderingDelayMs > 0 then
        local currentHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
        if currentHead and #currentHead >= 2 then
            local headReleaseAt = tonumber(currentHead[2])
            local ttlMs = math.max(1, headReleaseAt - now)
            redis.call("SET", timerKey, "1", "PX", ttlMs)
        end
    end

    return results
end

-- Promote one delayed job
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now
-- Returns: 1 if promoted, 0 otherwise
local function promoteDelayedOne(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])

    local delayedKey = ns .. ":delayed"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Find one job that is due now
    local ids = redis.call("ZRANGEBYSCORE", delayedKey, 0, now, "LIMIT", 0, 1)
    if not ids or #ids == 0 then
        return 0
    end

    local jobId = ids[1]

    -- Try to remove it atomically; if another scheduler raced, ZREM will return 0
    local removed = redis.call("ZREM", delayedKey, jobId)
    if removed == 0 then
        return 0
    end

    -- Determine its group and update ready queue if it was the head
    local jobKey = ns .. ":job:" .. jobId
    local groupId = redis.call("HGET", jobKey, "groupId")
    if not groupId then
        return 1 -- treat as moved even if metadata missing
    end

    -- Mark job as waiting (no longer delayed)
    redis.call("HSET", jobKey, "status", "waiting")
    redis.call("HDEL", jobKey, "runAt", "delayUntil")

    local gZ = ns .. ":g:" .. groupId
    local score = tonumber(redis.call("HGET", jobKey, "score"))
    if score then
        -- [PHYSICAL SEPARATION] Add back to group ZSET
        redis.call("ZADD", gZ, score, jobId)
        redis.call("SADD", ns .. ":groups", groupId)

        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headJobId = head[1]
            local headScore = tonumber(head[2])

            local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
            local limit = getGroupLimit(ns, groupId)
            local currentActive = redis.call("LLEN", groupActiveKey)

            -- [LIMITED GROUP SET] Check group capacity
            if currentActive >= limit then
                -- Group is full, move to limited
                redis.call("ZREM", readyKey, groupId)
                redis.call("ZADD", limitedKey, headScore, groupId)
            else
                -- Group has slots, move to ready
                redis.call("ZREM", limitedKey, groupId)
                redis.call("ZADD", readyKey, headScore, groupId)
            end
        end
    end

    return 1
end

-- Promote staged jobs to waiting state
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now, limit
-- Returns: count of promoted jobs
local function promoteStaged(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])
    local limit = tonumber(args[2]) or 100

    local stageKey = ns .. ":stage"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"
    local timerKey = ns .. ":stage:timer"

    local promotedCount = 0

    -- Get jobs that are ready (score <= now)
    local readyJobs = redis.call("ZRANGEBYSCORE", stageKey, 0, now, "LIMIT", 0, limit)

    for i = 1, #readyJobs do
        local jobId = readyJobs[i]
        local jobKey = ns .. ":job:" .. jobId

        -- Get job metadata
        local jobData = redis.call("HMGET", jobKey, "groupId", "score", "status")
        local groupId = jobData[1]
        local score = jobData[2]
        local status = jobData[3]

        if groupId and score and status == "staged" then
            local gZ = ns .. ":g:" .. groupId

            -- Remove from staging set
            redis.call("ZREM", stageKey, jobId)

            -- Add to group ZSET with original score
            redis.call("ZADD", gZ, tonumber(score), jobId)
            redis.call("SADD", ns .. ":groups", groupId)

            -- Update job status from "staged" to "waiting"
            redis.call("HSET", jobKey, "status", "waiting")

            -- Check if group should be added to ready queue
            -- Add group to ready if the head job is now waiting (not delayed or staged)
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headJobId = head[1]
                local headScore = tonumber(head[2])
                local headJobKey = ns .. ":job:" .. headJobId
                local headStatus = redis.call("HGET", headJobKey, "status")

                -- [LIMITED GROUP SET] Check if head job is waiting and evaluate capacity
                if headStatus == "waiting" then
                    local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
                    local groupLimit = getGroupLimit(ns, groupId)
                    local currentActive = redis.call("LLEN", groupActiveKey)

                    if currentActive >= groupLimit then
                        -- Group is full, move to limited
                        redis.call("ZREM", readyKey, groupId)
                        redis.call("ZADD", limitedKey, headScore, groupId)
                    else
                        -- Group has slots, move to ready
                        redis.call("ZREM", limitedKey, groupId)
                        redis.call("ZADD", readyKey, headScore, groupId)
                    end
                end
            end

            promotedCount = promotedCount + 1
        end
    end

    -- Recompute timer: set to the next earliest staged job
    local nextHead = redis.call("ZRANGE", stageKey, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
        local nextReleaseAt = tonumber(nextHead[2])
        -- Set timer to expire when the next earliest job is ready
        local ttlMs = math.max(1, nextReleaseAt - now)
        redis.call("SET", timerKey, "1", "PX", ttlMs)
    else
        -- No more staged jobs, delete the timer
        redis.call("DEL", timerKey)
    end

    return promotedCount
end

-- Change job delay (move between delayed and waiting states)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, newDelayUntil, now
-- Returns: 1 if successful, 0 if failed
local function changeDelay(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local newDelayUntil = tonumber(args[2])
    local now = tonumber(args[3])

    -- Validate required parameters
    if not newDelayUntil or not now then
        return 0
    end

    local jobKey = ns .. ":job:" .. jobId
    local delayedKey = ns .. ":delayed"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Check if job exists
    local exists = redis.call("EXISTS", jobKey)
    if exists == 0 then
        return 0
    end

    local groupId = redis.call("HGET", jobKey, "groupId")
    if not groupId then
        return 0
    end

    local gZ = ns .. ":g:" .. groupId

    -- Check if job is currently in delayed set
    local inDelayed = redis.call("ZSCORE", delayedKey, jobId)
    -- Check if job is currently in group ZSET
    local inGroup = redis.call("ZSCORE", gZ, jobId)

    -- If it's not in either, it might be processing or completed/failed
    -- We only allow changing delay for waiting or delayed jobs
    if not inDelayed and not inGroup then
        return 0
    end

    -- Update job's delayUntil field
    redis.call("HSET", jobKey, "delayUntil", tostring(newDelayUntil))

    if newDelayUntil > 0 and newDelayUntil > now then
        -- Job should be delayed: add to delayed set and REMOVE from group ZSET
        redis.call("HSET", jobKey, "status", "delayed")
        redis.call("ZADD", delayedKey, newDelayUntil, jobId)
        redis.call("ZREM", gZ, jobId)

        -- Update group status in ready/limited
        local jobCount = redis.call("ZCARD", gZ)
        if jobCount == 0 then
            redis.call("ZREM", readyKey, groupId)
            redis.call("ZREM", limitedKey, groupId)
        else
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headScore = tonumber(head[2])
                if redis.call("ZSCORE", readyKey, groupId) then
                    redis.call("ZADD", readyKey, headScore, groupId)
                elseif redis.call("ZSCORE", limitedKey, groupId) then
                    redis.call("ZADD", limitedKey, headScore, groupId)
                end
            end
        end
    else
        -- Job should be ready immediately: remove from delayed and ADD to group ZSET
        redis.call("HSET", jobKey, "status", "waiting")
        if inDelayed then
            redis.call("ZREM", delayedKey, jobId)
        end

        local score = tonumber(redis.call("HGET", jobKey, "score"))
        if score then
            redis.call("ZADD", gZ, score, jobId)
        end

        -- [LIMITED GROUP SET] Check group capacity and update ready/limited
        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headJobId = head[1]
            local headScore = tonumber(head[2])

            local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
            local limit = getGroupLimit(ns, groupId)
            local currentActive = redis.call("LLEN", groupActiveKey)

            if currentActive >= limit then
                -- Group is full, move to limited
                redis.call("ZREM", readyKey, groupId)
                redis.call("ZADD", limitedKey, headScore, groupId)
            else
                -- Group has slots, move to ready
                redis.call("ZREM", limitedKey, groupId)
                redis.call("ZADD", readyKey, headScore, groupId)
            end
        end
    end

    return 1
end

-- Record job result (for parent-child flows)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, status, timestamp, resultOrError, keepCompleted, keepFailed,
--         processedOn, finishedOn, attempts, maxAttempts, token
-- Returns: 1 if successful, 0 if failed
local function recordJobResult(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local status = args[2]
    local timestamp = tonumber(args[3])
    local resultOrError = args[4]
    local keepCompleted = tonumber(args[5])
    local keepFailed = tonumber(args[6])
    local processedOn = args[7]
    local finishedOn = args[8]
    local attempts = args[9]
    local maxAttempts = args[10]
    local token = args[11]

    local jobKey = ns .. ":job:" .. jobId

    -- Token verification: Ensure only the correct worker can record final failure
    local procKey = ns .. ":processing:" .. jobId
    local storedToken = redis.call("HGET", procKey, "token")
    if token and (not storedToken or storedToken ~= token) then
        -- Token mismatch: This worker has lost the lock, reject the operation
        return 0
    end

    -- Get parentId before potentially deleting the job
    local parentId = redis.call("HGET", jobKey, "parentId")

    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Verify job exists and check current status to prevent race conditions
    local currentStatus = redis.call("HGET", jobKey, "status")
    if not currentStatus then
        -- Job doesn't exist, likely already cleaned up
        return 0
    end

    -- If job is in "waiting" state, this might be a late completion after stalled recovery
    if currentStatus == "waiting" then
        -- Job was recovered by stalled check and possibly being processed by another worker
        -- Ignore this late completion to prevent corruption
        return 0
    end

    -- Update Flow Parent if exists
    if parentId then
        updateParentFlow(ns, jobId, parentId, status, resultOrError, timestamp)
    end

    -- Record job metadata (completed or failed)
    if status == "completed" then
        local completedKey = ns .. ":completed"

        -- CRITICAL: Always set final status first, even if job will be deleted
        redis.call("HSET", jobKey, "status", "completed")

        if keepCompleted > 0 then
            -- Store full job metadata and add to completed set
            redis.call("HSET", jobKey,
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts,
                "returnvalue", resultOrError
            )
            redis.call("ZADD", completedKey, timestamp, jobId)

            -- Trim old entries atomically
            trimCompleted(ns, keepCompleted)
        else
            -- keepCompleted == 0: Delete immediately
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. jobId)
            redis.call("DEL", ns .. ":flow:results:" .. jobId)
        end

    elseif status == "failed" then
        local failedKey = ns .. ":failed"
        local errorInfo = cjson.decode(resultOrError)

        -- CRITICAL: Always set final status first, even if job will be deleted
        redis.call("HSET", jobKey, "status", "failed")

        if keepFailed > 0 then
            redis.call("HSET", jobKey,
                "failedReason", errorInfo.message or "Error",
                "failedName", errorInfo.name or "Error",
                "stacktrace", errorInfo.stack or "",
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts
            )
            redis.call("ZADD", failedKey, timestamp, jobId)
        else
            -- Delete job
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. jobId)
            redis.call("DEL", ns .. ":flow:results:" .. jobId)
        end
    end

    -- Publish completion/failure event for waiters
    local eventPayload = cjson.encode({
        id = jobId,
        status = status,
        result = resultOrError
    })
    redis.call("PUBLISH", ns .. ":events", eventPayload)

    return 1
end

-- Check for stalled jobs and move them back to waiting or fail them
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now, gracePeriod, maxStalledCount
-- Returns: array of [jobId, groupId, action] for each stalled job found
--   action: "recovered", "delayed", or "failed"
local function checkStalled(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])
    local gracePeriod = tonumber(args[2]) or 0
    local maxStalledCount = tonumber(args[3]) or 1

    -- Circuit breaker for high concurrency: limit stalled job recovery
    local circuitBreakerKey = ns .. ":stalled:circuit"
    local lastCheck = redis.call("GET", circuitBreakerKey)
    if lastCheck then
        local lastCheckTime = tonumber(lastCheck)
        local circuitBreakerInterval = 2000
        if lastCheckTime and (now - lastCheckTime) < circuitBreakerInterval then
            return {}
        end
    end
    redis.call("SET", circuitBreakerKey, now, "PX", 3000)

    local processingKey = ns .. ":processing"
    local groupsKey = ns .. ":groups"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    -- Candidates: jobs whose deadlines are past
    local candidates = redis.call("ZRANGEBYSCORE", processingKey, 0, now - gracePeriod, "LIMIT", 0, 100)
    if not candidates or #candidates == 0 then
        return {}
    end

    local results = {}

    for _, jobId in ipairs(candidates) do
        local jobKey = ns .. ":job:" .. jobId
        local h = redis.call("HMGET", jobKey, "groupId","stalledCount","maxAttempts","attempts","status","finishedOn","score","delayUntil")
        local groupId = h[1]
        if groupId then
            local stalledCount = tonumber(h[2]) or 0
            local maxAttempts = tonumber(h[3]) or 3
            local attempts = tonumber(h[4]) or 0
            local status = h[5]
            local finishedOn = tonumber(h[6] or "0")
            local score = tonumber(h[7])
            local delayUntil = tonumber(h[8] or "0")

            if status == "processing" then
                stalledCount = stalledCount + 1
                attempts = attempts + 1
                redis.call("HSET", jobKey, "stalledCount", stalledCount, "attempts", attempts)

                local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
                redis.call("LREM", groupActiveKey, 1, jobId)

                local shouldFail = false
                local failReason = ""

                if stalledCount >= maxStalledCount and maxStalledCount > 0 then
                    shouldFail = true
                    failReason = "Job stalled " .. stalledCount .. " times (max: " .. maxStalledCount .. ")"
                elseif attempts > maxAttempts then
                    shouldFail = true
                    failReason = "Job exceeded max attempts (" .. attempts .. "/" .. maxAttempts .. ") due to stalls"
                end

                if shouldFail then
                    redis.call("ZREM", processingKey, jobId)
                    local groupKey = ns .. ":g:" .. groupId
                    redis.call("ZREM", groupKey, jobId)
                    redis.call("DEL", ns .. ":processing:" .. jobId)
                    redis.call("HSET", jobKey, "status","failed","finishedOn", now, "failedReason", failReason)
                    redis.call("ZADD", ns .. ":failed", now, jobId)
                    table.insert(results, jobId); table.insert(results, groupId); table.insert(results, "failed")
                else
                    local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)
                    if stillInProcessing then
                        redis.call("ZREM", processingKey, jobId)
                        redis.call("DEL", ns .. ":processing:" .. jobId)

                        local groupKey2 = ns .. ":g:" .. groupId

                        if delayUntil > 0 and delayUntil > now then
                            redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
                            redis.call("HSET", jobKey, "status", "delayed")

                            local head = redis.call("ZRANGE", groupKey2, 0, 0, "WITHSCORES")
                            if head and #head >= 2 then
                                local headScore = tonumber(head[2])
                                if redis.call("ZSCORE", readyKey, groupId) then
                                    redis.call("ZADD", readyKey, headScore, groupId)
                                elseif redis.call("ZSCORE", limitedKey, groupId) then
                                    redis.call("ZADD", limitedKey, headScore, groupId)
                                end
                            end
                            table.insert(results, jobId); table.insert(results, groupId); table.insert(results, "delayed")
                        elseif score then
                            redis.call("ZADD", groupKey2, score, jobId)
                            redis.call("HSET", jobKey, "status", "waiting")

                            local head = redis.call("ZRANGE", groupKey2, 0, 0, "WITHSCORES")
                            if head and #head >= 2 then
                                local headScore = tonumber(head[2])
                                local limit = getGroupLimit(ns, groupId)
                                local currentActive = redis.call("LLEN", groupActiveKey)

                                if currentActive < limit then
                                    redis.call("ZREM", limitedKey, groupId)
                                    redis.call("ZADD", readyKey, headScore, groupId)
                                else
                                    redis.call("ZREM", readyKey, groupId)
                                    redis.call("ZADD", limitedKey, headScore, groupId)
                                end
                            end
                            redis.call("SADD", groupsKey, groupId)
                            table.insert(results, jobId); table.insert(results, groupId); table.insert(results, "recovered")
                        end
                    end
                end
            end
        end
    end

    return results
end

-- Clean up old jobs by status (completed, failed, or delayed)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: status, graceAtMs, limit
-- Returns: count of removed jobs
local function cleanStatus(keys, args)
    local ns = keys[1]
    local status = args[1]
    local graceAt = tonumber(args[2]) or 0
    local limit = tonumber(args[3]) or 1000

    local setKey = nil
    if status == 'completed' then
        setKey = ns .. ':completed'
    elseif status == 'failed' then
        setKey = ns .. ':failed'
    elseif status == 'delayed' then
        setKey = ns .. ':delayed'
    else
        return 0
    end

    local ids = redis.call('ZRANGEBYSCORE', setKey, '-inf', graceAt, 'LIMIT', 0, limit)

    local readyKey = ns .. ':ready'
    local limitedKey = ns .. ':limited'

    local removed = 0
    for i = 1, #ids do
        local id = ids[i]
        local jobKey = ns .. ':job:' .. id

        redis.call('ZREM', setKey, id)

        local groupId = redis.call('HGET', jobKey, 'groupId')
        local parentId = redis.call('HGET', jobKey, 'parentId')
        if groupId then
            local gZ = ns .. ':g:' .. groupId
            redis.call('ZREM', gZ, id)

            local groupMetaKey = ns .. ":g:" .. groupId .. ":meta"
            local remainingJobs = tonumber(redis.call("HGET", groupMetaKey, "count")) or 0

            if status == "delayed" then
                remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))
            end

            if remainingJobs <= 0 then
                redis.call('ZREM', readyKey, groupId)
                redis.call('ZREM', limitedKey, groupId)
                redis.call('DEL', gZ)
                redis.call('DEL', groupMetaKey)
                redis.call('SREM', ns .. ':groups', groupId)
            elseif status == 'delayed' then
                local head = redis.call('ZRANGE', gZ, 0, 0, 'WITHSCORES')
                if head and #head >= 2 then
                    local headScore = tonumber(head[2])
                    if redis.call('ZSCORE', readyKey, groupId) then
                        redis.call('ZADD', readyKey, headScore, groupId)
                    elseif redis.call('ZSCORE', limitedKey, groupId) then
                        redis.call('ZADD', limitedKey, headScore, groupId)
                    end
                end
            end
        end

        redis.call('DEL',
            jobKey,
            ns .. ':unique:' .. id,
            ns .. ':flow:results:' .. id,
            ns .. ':flow:children:' .. id
        )

        if parentId then
            local parentKey = ns .. ':job:' .. parentId
            local parentChildrenKey = ns .. ':flow:children:' .. parentId

            local removedFromSet = redis.call('SREM', parentChildrenKey, id)
            if removedFromSet == 1 then
                redis.call('HDEL', ns .. ':flow:results:' .. parentId, id)

                local remaining = redis.call('HINCRBY', parentKey, 'flowRemaining', -1)

                if remaining <= 0 then
                    local parentStatus = redis.call('HGET', parentKey, 'status')
                    if parentStatus == 'waiting-children' then
                        redis.call('HSET', parentKey, 'status', 'waiting')

                        local parentGroupId = redis.call('HGET', parentKey, 'groupId')
                        if parentGroupId then
                            local parentScore = tonumber(redis.call('HGET', parentKey, 'score'))
                            if not parentScore then
                                parentScore = tonumber(redis.call('TIME')[1]) * 1000
                            end

                            local pGZ = ns .. ':g:' .. parentGroupId
                            redis.call('ZADD', pGZ, parentScore, parentId)
                            redis.call('SADD', ns .. ':groups', parentGroupId)

                            local pHead = redis.call('ZRANGE', pGZ, 0, 0, 'WITHSCORES')
                            if pHead and #pHead >= 2 then
                                local pHeadScore = tonumber(pHead[2])
                                local pGroupActiveKey = ns .. ':g:' .. parentGroupId .. ':active'
                                local pLimit = getGroupLimit(ns, parentGroupId)
                                local pCurrentActive = redis.call('LLEN', pGroupActiveKey)

                                if pCurrentActive >= pLimit then
                                    redis.call('ZREM', readyKey, parentGroupId)
                                    redis.call('ZADD', limitedKey, pHeadScore, parentGroupId)
                                else
                                    redis.call('ZREM', limitedKey, parentGroupId)
                                    redis.call('ZADD', readyKey, pHeadScore, parentGroupId)
                                end
                            end
                        end
                    end
                end
            end
        end

        removed = removed + 1
    end

    return removed
end

-- Check if a group is poisoned (all jobs exceeded max attempts)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: groupId, now
-- Returns: "ok", "empty", "locked", or "poisoned"
local function cleanupPoisonedGroup(keys, args)
    local ns = keys[1]
    local groupId = args[1]
    local now = tonumber(args[2])

    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"
    local gZ = ns .. ":g:" .. groupId
    local lockKey = ns .. ":lock:" .. groupId

    local jobCount = redis.call("ZCARD", gZ)
    if jobCount == 0 then
        redis.call("ZREM", readyKey, groupId)
        return "empty"
    end

    local lockValue = redis.call("GET", lockKey)
    if lockValue then
        local lockTtl = redis.call("PTTL", lockKey)
        if lockTtl > 0 then
            return "locked"
        end
    end

    local jobs = redis.call("ZRANGE", gZ, 0, -1)
    local reservableJobs = 0
    for i = 1, #jobs do
        local jobId = jobs[i]
        local jobKey = ns .. ":job:" .. jobId
        local attempts = tonumber(redis.call("HGET", jobKey, "attempts"))
        local maxAttempts = tonumber(redis.call("HGET", jobKey, "maxAttempts"))
        if attempts and maxAttempts and attempts < maxAttempts then
            reservableJobs = reservableJobs + 1
        end
    end

    if reservableJobs == 0 then
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZREM", limitedKey, groupId)
        return "poisoned"
    end

    return "ok"
end

-- Complete a job and atomically reserve the next job with metadata
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: completedJobId, groupId, status, timestamp, resultOrError, keepCompleted, keepFailed,
--         processedOn, finishedOn, attempts, maxAttempts, now, vt, currentJobToken, nextJobToken
-- Returns: next job data string or nil if no next job
local function completeAndReserveNextWithMetadata(keys, args)
    local ns = keys[1]
    local completedJobId = args[1]
    local gid = args[2]
    local status = args[3]
    local timestamp = tonumber(args[4])
    local resultOrError = args[5]
    local keepCompleted = tonumber(args[6])
    local keepFailed = tonumber(args[7])
    local processedOn = args[8]
    local finishedOn = args[9]
    local attempts = args[10]
    local maxAttempts = args[11]
    local now = tonumber(args[12])
    local vt = tonumber(args[13])
    local currentJobToken = args[14]
    local nextJobToken = args[15]

    local processingKey = ns .. ":processing"
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    local jobKey = ns .. ":job:" .. completedJobId

    local jobStatus = redis.call("HGET", jobKey, "status")
    local stillInProcessing = redis.call("ZSCORE", processingKey, completedJobId)

    if jobStatus ~= "processing" or not stillInProcessing then
        return nil
    end

    local procKey = ns .. ":processing:" .. completedJobId
    local storedToken = redis.call("HGET", procKey, "token")

    if not storedToken or storedToken ~= currentJobToken then
        return nil
    end

    local parentId = redis.call("HGET", jobKey, "parentId")

    redis.call("HSET", jobKey, "status", "completing")
    redis.call("DEL", procKey)
    redis.call("ZREM", processingKey, completedJobId)

    if status == "completed" then
        local completedKey = ns .. ":completed"

        redis.call("HSET", jobKey, "status", "completed")

        if parentId then
            updateParentFlow(ns, completedJobId, parentId, status, resultOrError, timestamp)
        end

        if keepCompleted > 0 then
            redis.call("HSET", jobKey,
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts,
                "returnvalue", resultOrError
            )
            redis.call("ZADD", completedKey, timestamp, completedJobId)

            local zcount = redis.call("ZCARD", completedKey)
            local toRemove = zcount - keepCompleted
            if toRemove > 0 then
                local oldIds = redis.call("ZRANGE", completedKey, 0, toRemove - 1)
                if #oldIds > 0 then
                    redis.call("ZREMRANGEBYRANK", completedKey, 0, toRemove - 1)
                    for i = 1, #oldIds do
                        local oldId = oldIds[i]
                        redis.call("DEL", ns .. ":job:" .. oldId)
                        redis.call("DEL", ns .. ":unique:" .. oldId)
                        redis.call("DEL", ns .. ":flow:results:" .. oldId)
                    end
                end
            end
        else
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. completedJobId)
            redis.call("DEL", ns .. ":flow:results:" .. completedJobId)
        end

    elseif status == "failed" then
        local failedKey = ns .. ":failed"
        local errorInfo = cjson.decode(resultOrError)

        redis.call("HSET", jobKey, "status", "failed")

        if parentId then
            updateParentFlow(ns, completedJobId, parentId, status, resultOrError, timestamp)
        end

        if keepFailed > 0 then
            redis.call("HSET", jobKey,
                "failedReason", errorInfo.message or "Error",
                "failedName", errorInfo.name or "Error",
                "stacktrace", errorInfo.stack or "",
                "processedOn", processedOn,
                "finishedOn", finishedOn,
                "attempts", attempts,
                "maxAttempts", maxAttempts
            )
            redis.call("ZADD", failedKey, timestamp, completedJobId)
        else
            redis.call("DEL", jobKey)
            redis.call("DEL", ns .. ":unique:" .. completedJobId)
            redis.call("DEL", ns .. ":flow:results:" .. completedJobId)
        end
    end

    local eventPayload = cjson.encode({
        id = completedJobId,
        status = status,
        result = resultOrError
    })
    redis.call("PUBLISH", ns .. ":events", eventPayload)

    local groupActiveKey = ns .. ":g:" .. gid .. ":active"
    local activeJobId = redis.call("LINDEX", groupActiveKey, 0)

    local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
    local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

    if activeJobId == completedJobId then
        redis.call("LPOP", groupActiveKey)
    else
        redis.call("LREM", groupActiveKey, 1, completedJobId)
        return nil
    end

    local gZ = ns .. ":g:" .. gid
    local zpop = redis.call("ZPOPMIN", gZ, 1)
    if not zpop or #zpop == 0 then
        if remainingJobs <= 0 then
            redis.call("DEL", gZ)
            redis.call("DEL", groupMetaKey)
            redis.call("SREM", ns .. ":groups", gid)
            redis.call("ZREM", readyKey, gid)
            redis.call("ZREM", limitedKey, gid)
        else
            redis.call("ZREM", readyKey, gid)
            redis.call("ZREM", limitedKey, gid)
        end
        return nil
    end

    local nextJobId = zpop[1]
    local nextJobKey = ns .. ":job:" .. nextJobId
    local job = redis.call("HMGET", nextJobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
    local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

    if not id or id == false then
        local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if nextHead and #nextHead >= 2 then
            local nextScore = tonumber(nextHead[2])
            redis.call("ZADD", readyKey, nextScore, groupId)
        end

        return nil
    end

    redis.call("LPUSH", groupActiveKey, id)

    local procKey = ns .. ":processing:" .. id
    local deadline = now + vt
    redis.call("HSET", procKey,
        "groupId", groupId,
        "deadlineAt", tostring(deadline),
        "token", nextJobToken)

    local processingKey = ns .. ":processing"
    redis.call("ZADD", processingKey, deadline, id)

    redis.call("HSET", nextJobKey, "status", "processing")

    local limit = getGroupLimit(ns, gid)
    local currentActive = redis.call("LLEN", groupActiveKey)

    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
        local nextHeadScore = tonumber(nextHead[2])
        if currentActive < limit then
            redis.call("ZREM", limitedKey, groupId)
            redis.call("ZADD", readyKey, nextHeadScore, groupId)
        else
            redis.call("ZREM", readyKey, groupId)
            redis.call("ZADD", limitedKey, nextHeadScore, groupId)
        end
    else
        redis.call("ZREM", readyKey, groupId)
        redis.call("ZREM", limitedKey, groupId)
    end

    return id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. nextJobToken
end

-- Complete a job (basic version without metadata recording)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: jobId, groupId
-- Returns: 1 if successful, 0 if failed
local function complete(keys, args)
    local ns = keys[1]
    local jobId = args[1]
    local gid = args[2]

    redis.call("DEL", ns .. ":processing:" .. jobId)
    redis.call("ZREM", ns .. ":processing", jobId)

    local groupActiveKey = ns .. ":g:" .. gid .. ":active"
    redis.call("LREM", groupActiveKey, 1, jobId)

    local lockKey = ns .. ":lock:" .. gid
    local val = redis.call("GET", lockKey)
    if val == jobId then
        redis.call("DEL", lockKey)

        local groupMetaKey = ns .. ":g:" .. gid .. ":meta"
        local remainingJobs = tonumber(redis.call("HINCRBY", groupMetaKey, "count", -1))

        local gZ = ns .. ":g:" .. gid
        local jobCount = redis.call("ZCARD", gZ)
        if jobCount == 0 then
            if remainingJobs <= 0 then
                redis.call("DEL", gZ)
                redis.call("DEL", groupMetaKey)
                redis.call("SREM", ns .. ":groups", gid)
                redis.call("ZREM", ns .. ":ready", gid)
                redis.call("DEL", ns .. ":buffer:" .. gid)
                redis.call("ZREM", ns .. ":buffering", gid)
            else
                redis.call("ZREM", ns .. ":ready", gid)
            end
        else
            local groupBufferKey = ns .. ":buffer:" .. gid
            local isBuffering = redis.call("EXISTS", groupBufferKey)

            if isBuffering == 0 then
                local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                if nextHead and #nextHead >= 2 then
                    local nextScore = tonumber(nextHead[2])
                    local readyKey = ns .. ":ready"
                    redis.call("ZADD", readyKey, nextScore, gid)
                end
            end
        end

        return 1
    end
    return 0
end

-- Enqueue a flow (parent and children jobs atomically)
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: parentId, parentGroupId, parentData, parentMaxAttempts, parentOrderMs, now, parentGroupConfig, ...childrenArgs
-- Returns: array of child job IDs
local function enqueueFlow(keys, args)
    local ns = keys[1]
    local parentId = args[1]
    local parentGroupId = args[2]
    local parentData = args[3]
    local parentMaxAttempts = args[4]
    local parentOrderMs = tonumber(args[5])
    local now = tonumber(args[6])
    local parentGroupConfig = args[7]

    local baseEpoch = 1704067200000
    local parentKey = ns .. ":job:" .. parentId
    local uniqueKey = ns .. ":unique:" .. parentId
    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"

    if redis.call("EXISTS", uniqueKey) == 1 then
        return nil
    end
    redis.call("SET", uniqueKey, parentId)

    if parentGroupConfig and parentGroupConfig ~= "" and parentGroupConfig ~= "null" then
        local status, config = pcall(cjson.decode, parentGroupConfig)
        if status and config then
            local configKey = ns .. ":config:" .. parentGroupId
            local args_inner = {}
            for k, v in pairs(config) do
                if v ~= nil then
                    table.insert(args_inner, k)
                    table.insert(args_inner, tostring(v))
                end
            end
            if #args_inner > 0 then
                redis.call("HMSET", configKey, unpack(args_inner))
            end
        end
    end

    local childrenCount = (#args - 7) / 7

    local parentRelativeMs = parentOrderMs - baseEpoch
    local parentDaysSinceEpoch = math.floor(parentOrderMs / 86400000)
    local parentSeqKey = ns .. ":seq:" .. parentDaysSinceEpoch
    local parentSeq = redis.call("INCR", parentSeqKey)
    local parentScore = parentRelativeMs * 1000 + parentSeq

    redis.call("HMSET", parentKey,
        "id", parentId,
        "groupId", parentGroupId,
        "data", parentData,
        "attempts", "0",
        "maxAttempts", parentMaxAttempts,
        "timestamp", tostring(now),
        "orderMs", tostring(parentOrderMs),
        "score", tostring(parentScore),
        "seq", tostring(parentSeq),
        "status", "waiting-children",
        "flowRemaining", tostring(childrenCount),
        "isFlowParent", "1"
    )
    redis.call("SADD", ns .. ":groups", parentGroupId)
    redis.call("HINCRBY", ns .. ":g:" .. parentGroupId .. ":meta", "count", 1)

    local results = {}

    for i = 0, childrenCount - 1 do
        local offset = 7 + (i * 7)
        local childId = args[offset + 1]
        local childGroupId = args[offset + 2]
        local childData = args[offset + 3]
        local childMaxAttempts = args[offset + 4]
        local childOrderMs = tonumber(args[offset + 5])
        local childDelay = tonumber(args[offset + 6])
        local childGroupConfig = args[offset + 7]

        if childGroupConfig and childGroupConfig ~= "" and childGroupConfig ~= "null" then
            local status, config = pcall(cjson.decode, childGroupConfig)
            if status and config then
                local configKey = ns .. ":config:" .. childGroupId
                local args_inner = {}
                for k, v in pairs(config) do
                    if v ~= nil then
                        table.insert(args_inner, k)
                        table.insert(args_inner, tostring(v))
                    end
                end
                if #args_inner > 0 then
                    redis.call("HMSET", configKey, unpack(args_inner))
                end
            end
        end

        local childKey = ns .. ":job:" .. childId

        local relativeMs = childOrderMs - baseEpoch
        local daysSinceEpoch = math.floor(childOrderMs / 86400000)
        local seqKey = ns .. ":seq:" .. daysSinceEpoch
        local seq = redis.call("INCR", seqKey)
        local score = relativeMs * 1000 + seq

        redis.call("HMSET", childKey,
            "id", childId,
            "groupId", childGroupId,
            "parentId", parentId,
            "data", childData,
            "attempts", "0",
            "maxAttempts", childMaxAttempts,
            "timestamp", tostring(now),
            "orderMs", tostring(childOrderMs),
            "score", tostring(score),
            "seq", tostring(seq),
            "status", "waiting"
        )

        redis.call("SET", ns .. ":unique:" .. childId, childId)
        redis.call("SADD", ns .. ":groups", childGroupId)
        redis.call("HINCRBY", ns .. ":g:" .. childGroupId .. ":meta", "count", 1)

        redis.call("SADD", ns .. ":flow:children:" .. parentId, childId)

        if childDelay > 0 then
            local delayUntil = now + childDelay
            redis.call("HSET", childKey, "delayUntil", tostring(delayUntil), "status", "delayed")
            redis.call("ZADD", ns .. ":delayed", delayUntil, childId)
        else
            local gZ = ns .. ":g:" .. childGroupId
            redis.call("ZADD", gZ, score, childId)

            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headScore = tonumber(head[2])
                local groupActiveKey = ns .. ":g:" .. childGroupId .. ":active"
                local limit = getGroupLimit(ns, childGroupId)
                local currentActive = redis.call("LLEN", groupActiveKey)

                if currentActive >= limit then
                    redis.call("ZREM", readyKey, childGroupId)
                    redis.call("ZADD", limitedKey, headScore, childGroupId)
                else
                    redis.call("ZREM", limitedKey, childGroupId)
                    redis.call("ZADD", readyKey, headScore, childGroupId)
                end
            end
        end

        table.insert(results, childId)
    end

    return results
end

-- Atomic reserve from a specific group
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now, vt, targetGroupId, allowedJobId, token
-- Returns: job data string or "E_LIMIT" if group full or nil if no job
local function reserveAtomic(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])
    local vt = tonumber(args[2])
    local targetGroupId = args[3]
    local allowedJobId = args[4]
    local token = args[5]

    local readyKey = ns .. ":ready"
    local limitedKey = ns .. ":limited"
    local gZ = ns .. ":g:" .. targetGroupId
    local groupActiveKey = ns .. ":g:" .. targetGroupId .. ":active"

    if redis.call("GET", ns .. ":paused") then
        return nil
    end

    local limit = getGroupLimit(ns, targetGroupId)
    local activeCount = redis.call("LLEN", groupActiveKey)
    local processingKey = ns .. ":processing"

    if activeCount >= limit then
        local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
        local prunedCount = 0

        for _, jobId in ipairs(activeJobs) do
            local score = redis.call("ZSCORE", processingKey, jobId)
            if not score then
                redis.call("LREM", groupActiveKey, 0, jobId)
                prunedCount = prunedCount + 1
            end
        end

        if prunedCount > 0 then
            activeCount = math.max(0, activeCount - prunedCount)
        end
    end

    local canReserve = false

    if activeCount < limit then
        canReserve = true
    elseif allowedJobId then
        local items = redis.call("LRANGE", groupActiveKey, 0, -1)
        for _, id in ipairs(items) do
            if id == allowedJobId then
                canReserve = true
                break
            end
        end
    end

    if not canReserve then
        local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if head and #head >= 2 then
            local headScore = tonumber(head[2])
            if redis.call("ZCARD", gZ) > 0 then
                redis.call("ZREM", readyKey, targetGroupId)
                redis.call("ZADD", limitedKey, headScore, targetGroupId)
            end
        end
        return "E_LIMIT"
    end

    local head = redis.call("ZRANGE", gZ, 0, 0)
    if not head or #head == 0 then
        return nil
    end
    local headJobId = head[1]
    local jobKey = ns .. ":job:" .. headJobId

    local zpop = redis.call("ZPOPMIN", gZ, 1)
    if not zpop or #zpop == 0 then
        return nil
    end
    headJobId = zpop[1]

    local job = redis.call("HMGET", jobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
    local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

    if not id or id == false then
        local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
        if nextHead and #nextHead >= 2 then
            local nextScore = tonumber(nextHead[2])
            redis.call("ZADD", readyKey, nextScore, targetGroupId)
        end
        return nil
    end

    redis.call("LPUSH", groupActiveKey, id)

    local procKey = ns .. ":processing:" .. id
    local deadline = now + vt
    redis.call("HSET", procKey,
        "groupId", groupId,
        "deadlineAt", tostring(deadline),
        "token", token)

    local processingKey = ns .. ":processing"
    redis.call("ZADD", processingKey, deadline, id)

    redis.call("HSET", jobKey, "status", "processing")

    local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
    if nextHead and #nextHead >= 2 then
        local nextScore = tonumber(nextHead[2])
        local newActiveCount = activeCount + 1
        if newActiveCount < limit then
            redis.call("ZREM", limitedKey, targetGroupId)
            redis.call("ZADD", readyKey, nextScore, targetGroupId)
        else
            redis.call("ZREM", readyKey, targetGroupId)
            redis.call("ZADD", limitedKey, nextScore, targetGroupId)
        end
    else
        redis.call("ZREM", readyKey, targetGroupId)
        redis.call("ZREM", limitedKey, targetGroupId)
    end

    return id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. token
end

-- Reserve batch of jobs from multiple groups
-- Parameters via keys/args:
--   keys[1]: namespace
--   args: now, vt, maxBatch, tokenBase
-- Returns: array of job data strings
local function reserveBatch(keys, args)
    local ns = keys[1]
    local now = tonumber(args[1])
    local vt = tonumber(args[2])
    local maxBatch = tonumber(args[3]) or 16
    local tokenBase = args[4]

    local readyKey = ns .. ":ready"
    local processingKey = ns .. ":processing"
    local limitedKey = ns .. ":limited"

    if redis.call("GET", ns .. ":paused") then
        return {}
    end

    local out = {}

    local stalledCheckKey = ns .. ":stalled:lastcheck"
    local lastCheck = tonumber(redis.call("GET", stalledCheckKey)) or 0
    local stalledCheckInterval = math.min(math.floor(vt / 4), 5000)

    if (now - lastCheck) >= stalledCheckInterval then
        redis.call("SET", stalledCheckKey, tostring(now))

        local expiredJobs = redis.call("ZRANGEBYSCORE", processingKey, 0, now)
        if #expiredJobs > 0 then
            for _, jobId in ipairs(expiredJobs) do
                local procKey = ns .. ":processing:" .. jobId
                local procData = redis.call("HMGET", procKey, "groupId", "deadlineAt")
                local gid = procData[1]
                local deadlineAt = tonumber(procData[2])
                if gid and deadlineAt and now > deadlineAt then
                    local jobKey = ns .. ":job:" .. jobId
                    local jobData = redis.call("HMGET", jobKey, "score", "delayUntil")
                    local jobScore = tonumber(jobData[1])
                    local delayUntil = tonumber(jobData[2] or "0")

                    if jobScore then
                        local gZ = ns .. ":g:" .. gid

                        if delayUntil > 0 and delayUntil > now then
                            redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
                            redis.call("HSET", jobKey, "status", "delayed")

                            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                            if head and #head >= 2 then
                                local headScore = tonumber(head[2])
                                if redis.call("ZSCORE", readyKey, gid) then
                                    redis.call("ZADD", readyKey, headScore, gid)
                                elseif redis.call("ZSCORE", limitedKey, gid) then
                                    redis.call("ZADD", limitedKey, headScore, gid)
                                end
                            end
                        else
                            redis.call("ZADD", gZ, jobScore, jobId)
                            redis.call("HSET", jobKey, "status", "waiting")

                            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                            if head and #head >= 2 then
                                local headScore = tonumber(head[2])
                                local groupActiveKey = ns .. ":g:" .. gid .. ":active"
                                local limit = getGroupLimit(ns, gid)
                                local currentActive = redis.call("LLEN", groupActiveKey)

                                if currentActive >= limit then
                                    redis.call("ZREM", readyKey, gid)
                                    redis.call("ZADD", limitedKey, headScore, gid)
                                else
                                    redis.call("ZREM", limitedKey, gid)
                                    redis.call("ZADD", readyKey, headScore, gid)
                                end
                            end
                        end
                        redis.call("LREM", ns .. ":g:" .. gid .. ":active", 1, jobId)
                        redis.call("DEL", ns .. ":lock:" .. gid)
                        redis.call("DEL", procKey)
                        redis.call("ZREM", processingKey, jobId)
                    end
                end
            end
        end
    end

    local groups = redis.call("ZRANGE", readyKey, 0, maxBatch - 1, "WITHSCORES")
    if not groups or #groups == 0 then
        return {}
    end

    local processedGroups = {}
    for i = 1, #groups, 2 do
        local gid = groups[i]
        local gZ = ns .. ":g:" .. gid
        local groupActiveKey = ns .. ":g:" .. gid .. ":active"

        local activeCount = redis.call("LLEN", groupActiveKey)
        local limit = getGroupLimit(ns, gid)

        if activeCount >= limit then
            local activeJobs = redis.call("LRANGE", groupActiveKey, 0, -1)
            local prunedCount = 0

            for _, jobId in ipairs(activeJobs) do
                local score = redis.call("ZSCORE", processingKey, jobId)
                if not score then
                    redis.call("LREM", groupActiveKey, 0, jobId)
                    prunedCount = prunedCount + 1
                end
            end

            if prunedCount > 0 then
                activeCount = math.max(0, activeCount - prunedCount)
            end
        end

        if activeCount < limit then
            local head = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if head and #head >= 2 then
                local headJobId = head[1]
                local headScore = tonumber(head[2])
                local headJobKey = ns .. ":job:" .. headJobId

                local zpop = redis.call("ZPOPMIN", gZ, 1)
                if zpop and #zpop > 0 then
                    local jobId = zpop[1]

                    local jobKey = ns .. ":job:" .. jobId
                    local job = redis.call("HMGET", jobKey, "id","groupId","data","attempts","maxAttempts","seq","timestamp","orderMs","score","isFlowParent")
                    local id, groupId, payload, attempts, maxAttempts, seq, enq, orderMs, score, isFlowParent = job[1], job[2], job[3], job[4], job[5], job[6], job[7], job[8], job[9], job[10]

                    if not id or id == false then
                        local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                        if nextHead and #nextHead >= 2 then
                            local nextScore = tonumber(nextHead[2])
                            redis.call("ZADD", readyKey, nextScore, gid)
                        end
                    else
                        local token = tokenBase .. "-" .. i

                        redis.call("LPUSH", groupActiveKey, jobId)

                        redis.call("HSET", jobKey, "status", "processing")

                        local procKey = ns .. ":processing:" .. id
                        local deadline = now + vt
                        redis.call("HSET", procKey,
                            "groupId", gid,
                            "deadlineAt", tostring(deadline),
                            "token", token)
                        redis.call("ZADD", processingKey, deadline, id)

                        local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
                        if nextHead and #nextHead >= 2 then
                            local nextScore = tonumber(nextHead[2])
                            local newActiveCount = activeCount + 1
                            if newActiveCount < limit then
                                redis.call("ZADD", readyKey, nextScore, gid)
                            else
                                redis.call("ZADD", limitedKey, nextScore, gid)
                            end
                        end

                        table.insert(out, id .. "|||" .. groupId .. "|||" .. payload .. "|||" .. attempts .. "|||" .. maxAttempts .. "|||" .. seq .. "|||" .. enq .. "|||" .. orderMs .. "|||" .. score .. "|||" .. deadline .. "|||" .. (isFlowParent or "0") .. "|||" .. token)
                        table.insert(processedGroups, gid)
                    end
                end
            end
        else
            local nextHead = redis.call("ZRANGE", gZ, 0, 0, "WITHSCORES")
            if nextHead and #nextHead >= 2 then
                local nextScore = tonumber(nextHead[2])
                redis.call("ZREM", readyKey, gid)
                redis.call("ZADD", limitedKey, nextScore, gid)
            end
        end
    end

    for _, gid in ipairs(processedGroups) do
        redis.call("ZREM", readyKey, gid)
    end

    return out
end

-- Validate the limited group set for consistency
-- Parameters via keys/args:
--   keys[1]: namespace
-- Returns: JSON string with validation stats
local function validateLimitedSet(keys, args)
    local ns = keys[1]
    local limitedKey = ns .. ":limited"
    local readyKey = ns .. ":ready"

    local stats = {
        total = 0,
        valid = 0,
        invalid = {},
        missing = {}
    }

    local limitedGroups = redis.call("ZRANGE", limitedKey, 0, -1)
    stats.total = #limitedGroups

    for i = 1, #limitedGroups do
        local gid = limitedGroups[i]
        local gZ = ns .. ":g:" .. gid
        local groupActiveKey = ns .. ":g:" .. gid .. ":active"

        local jobCount = redis.call("ZCARD", gZ)
        local currentActive = redis.call("LLEN", groupActiveKey)
        local limit = getGroupLimit(ns, gid)

        if jobCount == 0 then
            table.insert(stats.invalid, {
                gid = gid,
                reason = "empty_group",
                jobCount = 0,
                activeCount = currentActive,
                limit = limit
            })
        elseif currentActive < limit then
            table.insert(stats.invalid, {
                gid = gid,
                reason = "not_at_capacity",
                jobCount = jobCount,
                activeCount = currentActive,
                limit = limit
            })
        elseif redis.call("ZSCORE", readyKey, gid) then
            table.insert(stats.invalid, {
                gid = gid,
                reason = "in_both_ready_and_limited",
                jobCount = jobCount,
                activeCount = currentActive,
                limit = limit
            })
        else
            stats.valid = stats.valid + 1
        end
    end

    local allGroups = redis.call("SMEMBERS", ns .. ":groups")
    for i = 1, #allGroups do
        local gid = allGroups[i]
        local gZ = ns .. ":g:" .. gid
        local groupActiveKey = ns .. ":g:" .. gid .. ":active"

        local jobCount = redis.call("ZCARD", gZ)
        local currentActive = redis.call("LLEN", groupActiveKey)
        local limit = getGroupLimit(ns, gid)

        if jobCount > 0 and currentActive >= limit then
            local isInLimited = redis.call("ZSCORE", limitedKey, gid)
            if not isInLimited then
                table.insert(stats.missing, {
                    gid = gid,
                    jobCount = jobCount,
                    activeCount = currentActive,
                    limit = limit
                })
            end
        end
    end

    return cjson.encode(stats)
end

-- ==========================================
-- 3. FUNCTION REGISTRATION
-- ==========================================
-- Register exported functions so they can be called via FCALL

redis.register_function('enqueue', enqueue)
redis.register_function('complete_with_metadata', completeWithMetadata)
redis.register_function('reserve', reserve)
redis.register_function('retry', retry)
redis.register_function('heartbeat', heartbeat)
redis.register_function('promote_delayed_jobs', promoteDelayedJobs)
redis.register_function('dead_letter', deadLetter)
redis.register_function('cleanup', cleanup)
redis.register_function('remove', remove)
redis.register_function('is_empty', isEmpty)
redis.register_function('get_active_count', getActiveCount)
redis.register_function('get_waiting_count', getWaitingCount)
redis.register_function('get_delayed_count', getDelayedCount)
redis.register_function('get_active_jobs', getActiveJobs)
redis.register_function('get_delayed_jobs', getDelayedJobs)
redis.register_function('get_unique_groups', getUniqueGroups)
redis.register_function('get_unique_groups_count', getUniqueGroupsCount)
redis.register_function('get_waiting_jobs', getWaitingJobs)
redis.register_function('enqueue_batch', enqueueBatch)
redis.register_function('promote_delayed_one', promoteDelayedOne)
redis.register_function('promote_staged', promoteStaged)
redis.register_function('change_delay', changeDelay)
redis.register_function('record_job_result', recordJobResult)

-- Additional functions (previously unmigrated)
redis.register_function('check_stalled', checkStalled)
redis.register_function('clean_status', cleanStatus)
redis.register_function('cleanup_poisoned_group', cleanupPoisonedGroup)
redis.register_function('complete_and_reserve_next_with_metadata', completeAndReserveNextWithMetadata)
redis.register_function('complete', complete)
redis.register_function('enqueue_flow', enqueueFlow)
redis.register_function('reserve_atomic', reserveAtomic)
redis.register_function('reserve_batch', reserveBatch)
redis.register_function('validate_limited_set', validateLimitedSet)
