import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Queue, Worker } from '../src'
import { createRedis } from './helpers/redis'
import { Redis } from 'ioredis'

describe('Flow: Child Retry Bug', () => {
  let redis: Redis
  const namespace = `test:flow-retry-bug:${Date.now()}`

  beforeAll(async () => {
    redis = createRedis()
  })

  afterAll(async () => {
    const keys = await redis.keys(`${namespace}*`)
    if (keys.length) await redis.del(keys)
    await redis.quit()
  })

  it('should not decrement flowRemaining on child retry, only on final failure', async () => {
    const queue = new Queue({
      redis,
      namespace,
      logger: true,
      keepCompleted: 10,
      keepFailed: 10,
    })

    const parentId = 'parent-retry-test'
    const child1Id = 'child-1-retry'
    const child2Id = 'child-2-retry'

    // 添加流：2个子任务，每个允许重试2次
    await queue.addFlow({
      parent: {
        jobId: parentId,
        groupId: 'g-parent',
        data: { name: 'parent' },
      },
      children: [
        { 
          jobId: child1Id, 
          groupId: 'g-child-1', 
          data: { name: 'child1', failTimes: 1 }, // 失败1次后成功
          maxAttempts: 2, // 允许重试2次
        },
        { 
          jobId: child2Id, 
          groupId: 'g-child-2', 
          data: { name: 'child2', failTimes: 1 }, // 失败1次后成功
          maxAttempts: 2, // 允许重试2次
        },
      ],
    })

    // 初始 flowRemaining 应该是 2
    let remaining = await queue.getFlowDependencies(parentId)
    expect(remaining).toBe(2)

    const attemptCounts: Record<string, number> = {}

    const worker = new Worker({
      queue,
      logger: true,
      handler: async (job) => {
        console.log(`Processing job: ${job.id}, attempt: ${job.attemptsMade}`)
        
        // 记录尝试次数
        attemptCounts[job.id] = (attemptCounts[job.id] || 0) + 1

        // 子任务逻辑
        if (job.data.failTimes !== undefined) {
          const currentAttempt = attemptCounts[job.id]
          if (currentAttempt <= job.data.failTimes) {
            console.log(`Job ${job.id} failing on attempt ${currentAttempt}`)
            throw new Error(`Planned failure ${currentAttempt}`)
          }
          console.log(`Job ${job.id} succeeding on attempt ${currentAttempt}`)
          return { success: true, attempt: currentAttempt }
        }

        // 父任务逻辑
        console.log(`Parent job ${job.id} executing`)
        const results = await queue.getFlowResults(job.id)
        return { childResults: results }
      },
    })

    worker.run()

    // 等待一段时间让第一次失败发生
    await new Promise((r) => setTimeout(r, 1000))

    // 检查 flowRemaining：应该仍然是 2，因为子任务还在重试中
    remaining = await queue.getFlowDependencies(parentId)
    console.log(`FlowRemaining after first failures: ${remaining}`)
    
    // 这里是关键断言：重试不应该减少 flowRemaining
    expect(remaining).toBe(2)

    // 等待所有任务完成
    await new Promise((r) => setTimeout(r, 3000))

    // 最终，所有子任务都应该成功，父任务应该执行
    remaining = await queue.getFlowDependencies(parentId)
    console.log(`Final flowRemaining: ${remaining}`)
    expect(remaining).toBe(0)

    const parent = await queue.getJob(parentId)
    expect(parent.status).toBe('completed')

    await worker.close()
  })

  it('should decrement flowRemaining only when child truly fails (dead-letter)', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-deadletter`,
      logger: true,
      keepCompleted: 10,
      keepFailed: 10,
    })

    const parentId = 'parent-dl-test'
    const child1Id = 'child-1-dl'
    const child2Id = 'child-2-dl'

    // 添加流：第一个子任务会彻底失败
    await queue.addFlow({
      parent: {
        jobId: parentId,
        groupId: 'g-parent',
        data: { name: 'parent' },
      },
      children: [
        { 
          jobId: child1Id, 
          groupId: 'g-child-1', 
          data: { name: 'child1', alwaysFail: true },
          maxAttempts: 2, // 失败2次后进入 dead-letter
        },
        { 
          jobId: child2Id, 
          groupId: 'g-child-2', 
          data: { name: 'child2', alwaysFail: false },
          maxAttempts: 2,
        },
      ],
    })

    let remaining = await queue.getFlowDependencies(parentId)
    expect(remaining).toBe(2)

    const worker = new Worker({
      queue,
      logger: true,
      handler: async (job) => {
        console.log(`Processing job: ${job.id}, attempt: ${job.attemptsMade}`)

        if (job.data.alwaysFail === true) {
          throw new Error('Always fail')
        }

        if (job.data.alwaysFail === false) {
          return { success: true }
        }

        // 父任务
        const results = await queue.getFlowResults(job.id)
        return { childResults: results }
      },
      backoff: () => 0, // 禁用 backoff，立即重试
    })

    worker.run()

    // 等待足够长的时间让失败任务完成所有重试
    await new Promise((r) => setTimeout(r, 3000))

    // 检查任务状态
    const child1 = await queue.getJob(child1Id)
    const child2 = await queue.getJob(child2Id)
    console.log(`Child1 status: ${child1?.status}, Child2 status: ${child2?.status}`)

    // 现在 flowRemaining 应该是 0，因为两个子任务都完成了（一个成功，一个失败）
    remaining = await queue.getFlowDependencies(parentId)
    console.log(`FlowRemaining after child failures: ${remaining}`)
    expect(remaining).toBe(0)

    const parent = await queue.getJob(parentId)
    expect(parent.status).toBe('completed')

    await worker.close()
  })
})
