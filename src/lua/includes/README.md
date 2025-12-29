# Lua Includes Library

This directory contains reusable Lua functions that are included in various queue operation scripts via the `@include` directive. This modularization reduces code duplication and improves maintainability.

## Files Overview

### 1. `stalled-recovery.lua`
Handles recovery of jobs that have timed out during processing (stalled jobs).

**Key Functions:**
- `recoverStalledJobs(ns, now, vt)` - Checks for expired jobs and recovers them

**Used by:**
- `reserve.lua` - Recovers stalled jobs before reserving new ones
- `reserve-batch.lua` - Batch version of stalled recovery
- `check-stalled.lua` - Dedicated stalled job checker

**Core Logic:**
- Scans the processing ZSET for jobs with expired deadlines
- Moves them back to group queue (waiting state) or delayed set
- Updates group ready/limited status accordingly
- Uses throttled checking (every 1/4 of visibility timeout, max 5s)

---

### 2. `concurrency-control.lua`
Manages group concurrency limits and ready/limited queue state transitions.

**Key Functions:**
- `getGroupConcurrencyLimit(ns, groupId)` - Gets group's concurrency limit
- `getGroupActiveCount(ns, groupId)` - Gets current active task count
- `isGroupAtCapacity(ns, groupId)` - Checks if group is at capacity
- `updateGroupState(ns, groupId, readyKey, limitedKey)` - Updates group queue position
- `getAvailableSlots(ns, groupId)` - Gets number of available slots

**Used by:**
- `reserve.lua` - Checks capacity before reserving
- `reserve-atomic.lua` - Atomic capacity check
- `reserve-batch.lua` - Batch capacity validation
- `retry.lua` - Updates state after retry
- `dead-letter.lua` - Updates state after dead-lettering

**Core Logic:**
- Active tasks are stored in per-group lists (vs group ZSETs)
- Ready queue: Groups with available capacity (activeCount < limit)
- Limited queue: Groups at capacity (activeCount >= limit)
- Score in queues = head job's priority

---

### 3. `ghost-cleanup.lua`
Handles cleanup of "ghost tasks" - tasks in active list but not in processing set.

**Key Functions:**
- `cleanupGhostTasks(ns, groupId, processingKey)` - Removes ghost tasks
- `detectGhostTasks(ns, groupId, processingKey)` - Detects without removing

**Used by:**
- `reserve.lua` - Lazy cleanup when group is at capacity
- `reserve-atomic.lua` - Cleanup during atomic reserve
- `reserve-batch.lua` - Cleanup during batch reserve

**Ghost Task Causes:**
- Worker crash without proper cleanup
- Stalled recovery race conditions
- Concurrent access races

**Cleanup Strategy:**
- Only triggers when activeCount >= limit (hot path protection)
- Validates each task against processing ZSET (authoritative source)
- Removes tasks not found in processing set

---

### 4. `job-data.lua`
Provides standard interface for reading and parsing job data.

**Key Functions:**
- `getJobFullData(jobKey)` - Reads 10 core job fields
- `parseJobData(jobData)` - Converts array to named object
- `validateJobData(jobData)` - Checks if data is complete
- `hasJobField(jobData, fieldIndex)` - Checks specific field
- `formatJobDataString(parsed, deadline, token)` - Formats return value

**Used by:**
- `reserve.lua` - Gets job data for reservation
- `reserve-atomic.lua` - Gets job data for atomic reserve
- `reserve-batch.lua` - Gets job data for batch operations
- `enqueue-flow.lua` - Gets job data for flow processing

**Fields Retrieved:**
1. id - Unique job identifier
2. groupId - Group job belongs to
3. data - Job payload (JSON)
4. attempts - Retry count
5. maxAttempts - Max retries allowed
6. seq - Sequence number
7. timestamp - Creation time
8. orderMs - Sort/priority order
9. score - Current sort key
10. isFlowParent - Flow parent indicator

---

### 5. `token-verify.lua`
Ensures only the correct worker can complete a job (prevents double-processing).

**Key Functions:**
- `verifyToken(ns, jobId, expectedToken)` - Verifies processing token
- `getJobToken(ns, jobId)` - Gets current token
- `hasActiveLock(ns, jobId)` - Checks if job has active lock

**Used by:**
- `retry.lua` - Validates retry permission
- `dead-letter.lua` - Validates dead-letter permission

**Token Lifecycle:**
1. Generated when job is reserved
2. Stored in processing lock
3. Verified on retry/completion
4. Cleared on recovery

**Verification Rules:**
- No token provided = always valid
- Token matches stored = valid
- Token provided but nothing stored = invalid (recovered)
- Mismatch = invalid (another worker has it)

---

### 6. `delayed-handling.lua`
Manages delayed jobs using physical separation (separate delayed ZSET).

**Key Functions:**
- `moveJobToDelayed(ns, jobId, groupId, delayUntil)` - Move to delayed
- `promoteJobFromDelayed(ns, jobId, groupId, jobScore)` - Move from delayed
- `promoteReadyDelayedJobs(ns, now, maxPromote)` - Bulk promote
- `changeJobDelay(ns, jobId, newDelayUntil)` - Adjust delay
- `isJobDelayed(ns, jobId)` - Check if delayed
- `getJobDelayTime(ns, jobId)` - Get delay expiry time

**Used by:**
- `retry.lua` - Delays retry with backoff
- `promote-delayed-one.lua` - Promotes single delayed job
- `promote-delayed-jobs.lua` - Promotes multiple delayed jobs
- `change-delay.lua` - Changes job delay

**Physical Separation Model:**
- Delayed jobs: Stored only in `:delayed` ZSET (by delayTime)
- Group waiting: Stored only in group ZSET (by priority)
- No overlaps: Clean separation of concerns
- Promotion: Moves from delayed ZSET to group ZSET

---

### 7. `group-status.lua`
Provides diagnostic and monitoring functions for group state.

**Key Functions:**
- `getGroupJobCount(ns, groupId)` - Count waiting jobs
- `isGroupEmpty(ns, groupId)` - Check if empty
- `getGroupHeadJob(ns, groupId)` - Get next job
- `getGroupHeadJobWithScore(ns, groupId)` - Get next job + score
- `getGroupActiveTaskCount(ns, groupId)` - Count active tasks
- `isJobActive(ns, groupId, jobId)` - Check if job is active
- `getGroupActiveJobs(ns, groupId)` - List all active jobs
- `getGroupDelayedCount(ns, groupId)` - Count delayed jobs
- `getGroupStatus(ns, groupId)` - Complete status snapshot

**Used by:**
- Monitoring scripts
- Debugging utilities
- Status queries (not hot path)

**Status Snapshot:**
```lua
{
  waitingCount,   -- Jobs in group ZSET
  activeCount,    -- Jobs being processed
  isEmpty,        -- Has no waiting jobs
  headJobId,      -- Next to process
  isReady,        -- In ready queue?
  isLimited       -- In limited queue?
}
```

---

### 8. `key-helpers.lua`
Provides consistent Redis key construction (single source of truth).

**Key Functions:**
- `makeGroupKey(ns, groupId)` - Group job ZSET
- `makeJobKey(ns, jobId)` - Job data hash
- `makeConfigKey(ns, groupId)` - Group config hash
- `makeProcessingKey(ns, jobId)` - Job processing lock
- `makeActiveListKey(ns, groupId)` - Active task list
- `makeGroupLockKey(ns, groupId)` - Group lock (legacy)
- `makeGroupMetaKey(ns, groupId)` - Group metadata hash
- `makeUniqueKey(ns, jobId)` - Unique constraint key
- `getJobKeys(ns, jobId, groupId)` - All job-related keys
- `getGroupKeys(ns, groupId)` - All group-related keys

**Key Patterns:**
```
ns:g:groupId           -- Group job ZSET
ns:g:groupId:active    -- Active task list
ns:g:groupId:meta      -- Group metadata
ns:job:jobId           -- Job data hash
ns:config:groupId      -- Group config
ns:processing:jobId    -- Job processing lock
ns:lock:groupId        -- Group lock
ns:unique:jobId        -- Unique constraint
ns:ready               -- Ready queue (ZSET)
ns:limited             -- Limited queue (ZSET)
ns:processing          -- All processing jobs (ZSET)
ns:delayed             -- All delayed jobs (ZSET)
ns:paused              -- Pause flag
ns:stalled:lastcheck   -- Last stalled check time
```

**Usage in Scripts:**
Prefer using helpers for consistency:
```lua
--- @include "includes/key-helpers"
local jobKey = makeJobKey(ns, jobId)
local data = redis.call("HGET", jobKey, "status")
```

---

## Include Syntax

To use these modules in a script, add `@include` directives at the top:

```lua
-- argv: ns, jobId, backoffMs, token
--- @include "includes/token-verify"
--- @include "includes/concurrency-control"
--- @include "includes/key-helpers"

local ns = KEYS[1]
local jobId = ARGV[1]

-- Now you can call functions from included modules
if verifyToken(ns, jobId, token) then
  -- Token is valid, proceed
  updateGroupState(ns, groupId, readyKey, limitedKey)
end
```

**Directive Format:**
- `--- @include "includes/module-name"` (preferred)
- `-- @include "includes/module-name"` (also supported)
- Path must be quoted with `"` or `'`
- Path is relative to `src/lua/`

---

## Dependency Graph

```
stalled-recovery.lua (no dependencies)
concurrent-control.lua (no dependencies)
ghost-cleanup.lua (no dependencies)
job-data.lua (no dependencies)
token-verify.lua (no dependencies)
delayed-handling.lua (no dependencies)
group-status.lua (uses concurrency-control)
key-helpers.lua (no dependencies)
```

---

## Best Practices

1. **Use helpers for consistency**
   - Always use `makeJobKey()` instead of string concatenation
   - Easier refactoring if key format changes

2. **Include only what you need**
   - Don't include unused modules
   - Keeps script size minimal

3. **Validate inputs**
   - Check if returned values are valid (not false)
   - Handle nil/empty cases

4. **Documentation**
   - Add comments explaining what functions do
   - Document parameters and return values

5. **Testing**
   - Test each include independently
   - Test interactions between includes

---

## Adding New Includes

1. Create new file in `src/lua/includes/`
2. Start with module documentation comment
3. Define functions with clear names
4. Add comments for each function (parameters, return, side effects)
5. Add README entry here
6. Use consistent naming conventions
7. Keep functions focused and reusable
8. Avoid circular dependencies

---

## Performance Considerations

- **Lazy Cleanup**: Ghost cleanup only runs when at capacity (hot path protection)
- **Throttled Recovery**: Stalled recovery uses adaptive throttling to avoid overhead
- **Caching**: Consider caching frequently accessed values (e.g., concurrency limits)
- **ZSET operations**: O(log N) for most group operations (acceptable)
- **List operations**: O(N) for ghost cleanup, but only at capacity (rare)

---

## Debugging

Common issues:

1. **"attempt to call nil value"**
   - Missing `@include` directive
   - Typo in function name
   - Function defined after use

2. **Ghost tasks not cleaned up**
   - Only runs when at capacity
   - Check processingKey matches actual ZSET

3. **Token verification fails**
   - Ensure token is being passed correctly
   - Check if job was recovered/reassigned

4. **State corruption**
   - Use `getGroupStatus()` to check actual state
   - Compare against expected state

---

## Version History

- **v1.0** - Initial includes library
  - 8 modules: stalled-recovery, concurrency-control, ghost-cleanup, job-data, token-verify, delayed-handling, group-status, key-helpers
  - Physical separation model for delayed jobs
  - Per-group active lists for concurrency control
