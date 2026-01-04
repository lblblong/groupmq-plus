--- @include "includes/concurrency-control/is-group-at-capacity"
--- @include "includes/group-lifecycle/update-group-ready-limited-state"
--- @include "includes/lock/check-lock"
--- @include "includes/lock/release-lock"

-- 入参: opts.ns, opts.now, opts.gracePeriod, opts.maxStalledCount, opts.maxJobsPerScan
-- 功能: 查询过期任务，恢复或失败处理
-- 返回: 处理结果数组 [jobId, groupId, action, ...]

local function recoverStalledJobsCompletely(opts)
  local ns = opts.ns
  local now = opts.now
  local gracePeriod = opts.gracePeriod
  local maxStalledCount = opts.maxStalledCount
  -- 每次扫描的最大任务数，默认 500（支持高并发场景）
  local maxJobsPerScan = opts.maxJobsPerScan or 500
  local processingKey = ns .. ":processing"
  local groupsKey = ns .. ":groups"
  local readyKey = opts.readyKey or (ns .. ":ready")
  local limitedKey = opts.limitedKey or (ns .. ":limited")

  -- [BullMQ 风格] 获取 processing 集合中的任务
  -- 不再依赖 deadline score，而是检查锁是否存在
  -- 使用 maxJobsPerScan 限制单次扫描数量，避免阻塞 Redis
  local processingJobs = redis.call("ZRANGE", processingKey, 0, maxJobsPerScan - 1)

  local results = {}

  for _, jobId in ipairs(processingJobs) do
    -- [关键] 检查独立锁是否存在
    -- 如果锁不存在（已过期），说明 Worker 已死，任务需要恢复
    local lockExists = checkLock({ ns = ns, jobId = jobId })
    
    if lockExists == 0 then
      -- 锁已过期，任务 stalled
      local jobKey = ns .. ":job:" .. jobId
      local h = redis.call("HMGET", jobKey, "groupId", "stalledCount", "maxAttempts", "attempts", "status", "score", "delayUntil")
      local groupId = h[1]

      if groupId then
        local stalledCount = tonumber(h[2]) or 0
        local maxAttempts = tonumber(h[3]) or 3
        local attempts = tonumber(h[4]) or 0
        local status = h[5]
        local score = tonumber(h[6])
        local delayUntil = tonumber(h[7] or "0")

        if status == "processing" then
          stalledCount = stalledCount + 1
          attempts = attempts + 1
          redis.call("HSET", jobKey, "stalledCount", stalledCount, "attempts", attempts)

          -- 从活跃列表移除
          local groupActiveKey = ns .. ":g:" .. groupId .. ":active"
          redis.call("LREM", groupActiveKey, 1, jobId)

          -- 判断是否应该失败
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
            -- 失败处理
            redis.call("ZREM", processingKey, jobId)
            local groupKey = ns .. ":g:" .. groupId
            redis.call("ZREM", groupKey, jobId)
            redis.call("DEL", ns .. ":processing:" .. jobId)
            -- [BullMQ 风格] 强制释放锁（无需 token，因为锁已过期）
            releaseLock({ ns = ns, jobId = jobId })
            redis.call("HSET", jobKey, "status", "failed", "finishedOn", now, "failedReason", failReason)
            redis.call("ZADD", ns .. ":failed", now, jobId)
            table.insert(results, jobId)
            table.insert(results, groupId)
            table.insert(results, "failed")
          else
            -- 恢复处理
            local stillInProcessing = redis.call("ZSCORE", processingKey, jobId)
            if stillInProcessing then
              redis.call("ZREM", processingKey, jobId)
              redis.call("DEL", ns .. ":processing:" .. jobId)
              -- [BullMQ 风格] 强制释放锁（无需 token，因为锁已过期）
              releaseLock({ ns = ns, jobId = jobId })

              local groupKey = ns .. ":g:" .. groupId

              if delayUntil > 0 and delayUntil > now then
                -- 任务仍在延迟中，只加入延迟集合
                redis.call("ZADD", ns .. ":delayed", delayUntil, jobId)
                redis.call("HSET", jobKey, "status", "delayed")

                -- 更新群组状态
                local head = redis.call("ZRANGE", groupKey, 0, 0, "WITHSCORES")
                if head and #head >= 2 then
                  local headScore = tonumber(head[2])
                  if redis.call("ZSCORE", readyKey, groupId) then
                    redis.call("ZADD", readyKey, headScore, groupId)
                  elseif redis.call("ZSCORE", limitedKey, groupId) then
                    redis.call("ZADD", limitedKey, headScore, groupId)
                  end
                end
                table.insert(results, jobId)
                table.insert(results, groupId)
                table.insert(results, "delayed")
              elseif score then
                -- 恢复到等待状态
                redis.call("ZADD", groupKey, score, jobId)
                redis.call("HSET", jobKey, "status", "waiting")

                -- 检查群组容量，决定是否进入ready或limited
                -- Module will internally fetch headScore if needed
                updateGroupReadyLimitedState({ ns = ns, groupId = groupId, readyKey = readyKey, limitedKey = limitedKey })
                redis.call("SADD", groupsKey, groupId)
                table.insert(results, jobId)
                table.insert(results, groupId)
                table.insert(results, "recovered")
              end
            end
          end
        end
      end
    end
  end

  return results
end

