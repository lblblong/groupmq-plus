import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Queue, Worker } from '../src'
import { createRedis } from './helpers/redis'
import { Redis } from 'ioredis'

describe('Parent-Child Flows', () => {
  let redis: Redis
  const namespace = `test:flow:${Date.now()}`

  beforeAll(async () => {
    redis = createRedis()
    const keys = await redis.keys(`${namespace}*`)
    if (keys.length) await redis.del(keys)
  })

  afterAll(async () => {
    await redis.quit()
  })

  it('should process parent only after all children complete', async () => {
    const queue = new Queue({
      redis,
      namespace,
      logger: true,
      keepCompleted: 10, // Keep enough completed jobs for verification
    })

    const parentId = 'parent-1'
    const child1Id = 'child-1'
    const child2Id = 'child-2'

    const parent = await queue.addFlow({
      parent: {
        jobId: parentId,
        groupId: 'g-parent',
        data: { name: 'parent' },
      },
      children: [
        { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
        { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
      ],
    })
    console.log('Flow added. Namespace:', namespace)

    // Check initial states
    expect(parent.status).toBe('waiting-children')

    const remaining = await queue.getFlowDependencies(parentId)
    expect(remaining).toBe(2)

    const worker = new Worker({
      queue,
      logger: true,
      handler: async (job) => {
        console.log('Processing job:', job.id)
      },
    })
    worker.run()

    // Wait for parent to complete (which means all children are also done)
    await parent.waitUntilFinished(5000)

    // Verify all jobs completed
    expect((await queue.getJob(child1Id)).status).toBe('completed')
    expect((await queue.getJob(child2Id)).status).toBe('completed')
    expect((await queue.getJob(parentId)).status).toBe('completed')
    expect(await queue.getFlowDependencies(parentId)).toBe(0)

    await worker.close()
  })

  it('should trigger parent even if a child fails completely', async () => {
    // 1. 配置队列
    const queue = new Queue({
      redis,
      namespace: `${namespace}-fail`,
      logger: false,
    })

    // 2. 添加 Flow：1个子任务必然失败
    await queue.addFlow({
      parent: { groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { groupId: 'c-g', data: { fail: true }, maxAttempts: 1 }, // 重试1次后失败
        { groupId: 'c-g', data: { fail: false } },
      ],
    })

    const completedJobs: string[] = []

    const worker = new Worker({
      queue,
      handler: async (job) => {
        if (job.data.fail) {
          throw new Error('Planned failure')
        }
        completedJobs.push(job.id)
        return 'ok'
      },
    })

    // 等待足够长的时间让失败发生并记录
    await new Promise((r) => setTimeout(r, 2000))

    // 验证：父任务是否进入了 Completed 状态 (虽然子任务失败，但父任务被触发执行了)
    // 注意：这里假设父任务本身执行成功。
    // 在实际业务中，父任务 handler 应该检查 getFlowResults() 里的结果来决定自己是成功还是失败
    const processedParent = completedJobs.find((id) => id.length > 10) // 简单的ID判断
    expect(processedParent).toBeDefined() // 父任务应该被执行

    await worker.close()
  })

  it('should store and retrieve child results via getFlowResults', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-results`,
      logger: false,
      keepCompleted: 10,
    })

    const parentId = 'parent-results'

    await queue.addFlow({
      parent: { jobId: parentId, groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { jobId: 'child-a', groupId: 'c-g', data: { value: 10 } },
        { jobId: 'child-b', groupId: 'c-g', data: { value: 20 } },
      ],
    })

    const worker = new Worker({
      queue,
      handler: async (job) => {
        if (job.data.value) {
          // 子任务返回计算结果
          return { computed: job.data.value * 2 }
        }
        // 父任务：获取所有子任务结果
        const results = await queue.getFlowResults(job.id)
        return { childResults: results }
      },
    })

    await new Promise((r) => setTimeout(r, 2000))

    // 验证子任务结果被正确存储
    const flowResults = await queue.getFlowResults(parentId)
    expect(flowResults.find((r) => r.jobId === 'child-a')?.result).toEqual({
      computed: 20,
    })
    expect(flowResults.find((r) => r.jobId === 'child-b')?.result).toEqual({
      computed: 40,
    })
    await worker.close()
  })

  it('should trigger parent when child is dead-lettered', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-deadletter`,
      logger: false,
      keepFailed: 10,
      keepCompleted: 10,
    })

    const parentId = 'parent-dl'

    const parentJob = await queue.addFlow({
      parent: { jobId: parentId, groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { jobId: 'child-ok', groupId: 'c-g-ok', data: { fail: false } }, // 不同的组
        {
          jobId: 'child-fail',
          groupId: 'c-g-fail',
          data: { fail: true },
          maxAttempts: 1,
        }, // 不同的组，只重试1次
      ],
    })

    const processedJobs: string[] = []

    const worker = new Worker({
      queue,
      handler: async (job) => {
        if (job.data.fail) {
          throw new Error('Intentional failure')
        }
        processedJobs.push(job.id)
        return 'success'
      },
    })

    await parentJob.waitUntilFinished()

    // 验证父任务被触发执行了
    expect(processedJobs).toContain(parentId)

    // 验证 flowResults 包含结果
    const flowResults = await parentJob.getChildrenValues()
    expect(flowResults.find((r) => r.jobId === 'child-ok')?.result).toBe(
      'success'
    )
    // 失败的子任务结果应该包含错误信息
    expect(
      flowResults.find((r) => r.jobId === 'child-fail')?.result
    ).toBeDefined()

    await worker.close()
  })

  it('父子任务均失败', async () => {
    let finalFailedJobs: string[] = []
    try {
      const queue = new Queue({
        redis,
        namespace,
        keepCompleted: 10,
        keepFailed: 10,
        maxAttempts: 2,
      })

      const parent = await queue.addFlow({
        parent: {
          jobId: 'parent-job',
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          {
            jobId: 'child-job-1',
            groupId: 'g-child-1',
            data: { name: 'child1' },
          },
          {
            jobId: 'child-job-2',
            groupId: 'g-child-2',
            data: { name: 'child2' },
          },
        ],
      })
      console.log('Flow added. Namespace:', namespace)

      const worker = new Worker({
        queue,
        handler: async (job) => {
          if (job.isFlowParent) {
            throw new Error(`Parent job ${job.id} failed intentionally`)
          } else {
            throw new Error(`Child job ${job.id} failed intentionally`)
          }
        },
      })
      worker.on('completed', (job) => {
        console.log(`[COMPLETED] ${job.name}-${job.id}`)
      })
      worker.on('failed', async (job) => {
        const isFinalFailure = job.attemptsMade >= job.opts.attempts - 1
        if (isFinalFailure) {
          console.error(
            `[FINAL FAILED] ${job.name}-${job.id}: ${job.failedReason}`
          )
          finalFailedJobs.push(job.id)
        } else {
          console.log(`[FAILED] ${job.name}-${job.id}: ${job.failedReason}`)
        }
      })

      await parent.waitUntilFinished()
      await new Promise((resolve) => setTimeout(resolve, 500)) // Wait a moment for logs

      await worker.close()
    } catch (err) {
      console.log(err)
    }

    expect(finalFailedJobs).toContain('parent-job')
    expect(finalFailedJobs).toContain('child-job-1')
    expect(finalFailedJobs).toContain('child-job-2')
  })

  it('should apply groupConfig to parent and children in a flow', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-groupconfig`,
      logger: false,
    })

    const parentGroupId = 'flow-parent-group'
    const child1GroupId = 'flow-child-group-1'
    const child2GroupId = 'flow-child-group-2'

    // Create a flow with groupConfig for parent and children
    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: { priority: 100, concurrency: 5 },
      },
      children: [
        {
          groupId: child1GroupId,
          data: { name: 'child1' },
          groupConfig: { priority: 50, concurrency: 2 },
        },
        {
          groupId: child2GroupId,
          data: { name: 'child2' },
          groupConfig: { priority: 75, concurrency: 3 },
        },
      ],
    })

    // Verify parent group config was set
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(100)
    expect(parentConfig.concurrency).toBe(5)

    // Verify child 1 group config was set
    const child1Config = await queue.groups.getConfig(child1GroupId)
    expect(child1Config.priority).toBe(50)
    expect(child1Config.concurrency).toBe(2)

    // Verify child 2 group config was set
    const child2Config = await queue.groups.getConfig(child2GroupId)
    expect(child2Config.priority).toBe(75)
    expect(child2Config.concurrency).toBe(3)

    // Verify the flow works correctly with group configs
    expect(parent.status).toBe('waiting-children')
    const remaining = await queue.getFlowDependencies(parent.id)
    expect(remaining).toBe(2)
  })

  it('should handle flow with partial groupConfig (only parent)', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-partial-config`,
      logger: false,
    })

    const parentGroupId = 'partial-parent-group'
    const childGroupId = 'partial-child-group'

    // Create a flow where only parent has groupConfig
    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: { priority: 90 },
      },
      children: [
        {
          groupId: childGroupId,
          data: { name: 'child' },
          // No groupConfig for child
        },
      ],
    })

    // Verify parent config was set
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(90)

    // Child group should exist but have no special config
    const childConfig = await queue.groups.getConfig(childGroupId)
    // childConfig should be empty or not contain priority
    expect(childConfig.priority).toBeUndefined()
  })

  it('should support custom groupConfig properties like weight', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}-custom-config`,
      logger: false,
    })

    const parentGroupId = 'custom-parent-group'
    const child1GroupId = 'custom-child-group-1'
    const child2GroupId = 'custom-child-group-2'

    // Create a flow with custom groupConfig properties (weight)
    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: {
          priority: 100,
          concurrency: 5,
          weight: 10, // Custom property
          customField: 'custom-value' // Another custom property
        },
      },
      children: [
        {
          groupId: child1GroupId,
          data: { name: 'child1' },
          groupConfig: {
            priority: 50,
            concurrency: 2,
            weight: 5 // Custom property
          },
        },
        {
          groupId: child2GroupId,
          data: { name: 'child2' },
          groupConfig: {
            priority: 75,
            concurrency: 3,
            weight: 8, // Custom property
            routingKey: 'route-key' // Another custom property
          },
        },
      ],
    })

    // Verify parent config including custom properties
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(100)
    expect(parentConfig.concurrency).toBe(5)
    expect(parentConfig.weight).toBe(10)
    expect(parentConfig.customField).toBe('custom-value')

    // Verify child 1 config with custom properties
    const child1Config = await queue.groups.getConfig(child1GroupId)
    expect(child1Config.priority).toBe(50)
    expect(child1Config.concurrency).toBe(2)
    expect(child1Config.weight).toBe(5)

    // Verify child 2 config with multiple custom properties
    const child2Config = await queue.groups.getConfig(child2GroupId)
    expect(child2Config.priority).toBe(75)
    expect(child2Config.concurrency).toBe(3)
    expect(child2Config.weight).toBe(8)
    expect(child2Config.routingKey).toBe('route-key')

    // Verify the flow works correctly with custom configs
    expect(parent.status).toBe('waiting-children')
    const remaining = await queue.getFlowDependencies(parent.id)
    expect(remaining).toBe(2)
  })
})

