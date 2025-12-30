import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PriorityStrategy, Queue, Worker } from '../../src'
import { createRedis } from '../helpers/redis'

let redis: Redis

beforeAll(async () => {
  redis = createRedis()
})

afterAll(async () => {
  await redis.quit()
})

describe('Flow API (任务流方法)', () => {
  const namespace = `test:job-flow-methods:${Date.now()}`

  beforeAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`)
    if (keys.length) await redis.del(keys)
  })

  afterAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`)
    if (keys.length) await redis.del(keys)
  })

  describe('parentId 属性', () => {
    it('应该为子任务设置 parentId', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-parentid`,
        keepCompleted: 10,
      })

      const parentId = 'parent-with-children'
      const childId = 'child-job-1'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      })

      const childJob = await queue.getJob(childId)
      expect(childJob.parentId).toBe(parentId)
    })

    it('应该为非子任务设置 undefined parentId', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-no-parent`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      expect(job.parentId).toBeUndefined()
    })

    it('应该为父任务设置 undefined parentId', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-parent-no-parentid`,
        keepCompleted: 10,
      })

      const parentId = 'parent-job'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [{ groupId: 'g-child', data: { name: 'child' } }],
      })

      const parentJob = await queue.getJob(parentId)
      expect(parentJob.parentId).toBeUndefined()
    })
  })

  describe('getChildren()', () => {
    it('应该返回父任务的所有子任务', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildren`,
        keepCompleted: 10,
      })

      const parentId = 'parent-get-children'
      const child1Id = 'child-gc-1'
      const child2Id = 'child-gc-2'

      const parentJob = await queue.addFlow({
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

      const children = await parentJob.getChildren()

      expect(children).toHaveLength(2)
      const childIds = children.map((c) => c.id).sort()
      expect(childIds).toEqual([child1Id, child2Id].sort())
    })

    it('应该为没有子任务的任务返回空数组', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildren-empty`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const children = await job.getChildren()

      expect(children).toEqual([])
    })

    it('应该优雅地跳过已删除的子任务', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildren-deleted`,
        keepCompleted: 10,
      })

      const parentId = 'parent-deleted-child'
      const child1Id = 'child-to-delete'
      const child2Id = 'child-to-keep'

      await queue.addFlow({
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

      // 直接从 Redis 删除一个子任务（模拟清理）
      await redis.del(
        `groupmq:${namespace}-getchildren-deleted:job:${child1Id}`
      )

      const parentJob = await queue.getJob(parentId)
      const children = await parentJob.getChildren()

      // 应该只返回剩余的子任务
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe(child2Id)
    })
  })

  describe('getChildrenValues()', () => {
    it('应该返回子任务的执行结果', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildrenvalues`,
        keepCompleted: 10,
      })

      const parentId = 'parent-values'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: 'child-v-1', groupId: 'g-child-1', data: { value: 10 } },
          { jobId: 'child-v-2', groupId: 'g-child-2', data: { value: 20 } },
        ],
      })

      const worker = new Worker({
        queue,
        handler: async (job) => {
          if (job.data.value) {
            return { computed: job.data.value * 2 }
          }
          return 'parent-done'
        },
      })

      // 等待处理完成
      await new Promise((r) => setTimeout(r, 2000))
      await worker.close()

      const parentJob = await queue.getJob(parentId)
      const values = await parentJob.getChildrenValues()

      expect(values.find((v) => v.jobId === 'child-v-1')?.result).toEqual({
        computed: 20,
      })
      expect(values.find((v) => v.jobId === 'child-v-2')?.result).toEqual({
        computed: 40,
      })
    })

    it('应该为没有子任务的任务返回空对象', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildrenvalues-empty`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const values = await job.getChildrenValues()

      expect(values).toEqual([])
    })
  })

  describe('getDependenciesCount()', () => {
    it('应该返回剩余子任务的正确数量', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getdepscount`,
        keepCompleted: 10,
      })

      const parentId = 'parent-deps'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          {
            jobId: 'child-d-1',
            groupId: 'g-child-1',
            data: { name: 'child1' },
          },
          {
            jobId: 'child-d-2',
            groupId: 'g-child-2',
            data: { name: 'child2' },
          },
          {
            jobId: 'child-d-3',
            groupId: 'g-child-3',
            data: { name: 'child3' },
          },
        ],
      })

      const parentJob = await queue.getJob(parentId)
      const count = await parentJob.getDependenciesCount()

      expect(count).toBe(3)
    })

    it('应该为非父任务返回 null', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getdepscount-null`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const count = await job.getDependenciesCount()

      expect(count).toBeNull()
    })
  })

  describe('getParent()', () => {
    it('应该为子任务返回父任务', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getparent`,
        keepCompleted: 10,
      })

      const parentId = 'parent-for-getparent'
      const childId = 'child-for-getparent'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      })

      const childJob = await queue.getJob(childId)
      const parent = await childJob.getParent()

      expect(parent).toBeDefined()
      expect(parent!.id).toBe(parentId)
      expect(parent!.data).toEqual({ name: 'parent' })
    })

    it('应该为没有父任务的任务返回 undefined', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getparent-undefined`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const parent = await job.getParent()

      expect(parent).toBeUndefined()
    })

    it('应该在父任务被删除时返回 undefined', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getparent-deleted`,
        keepCompleted: 10,
      })

      const parentId = 'parent-to-delete'
      const childId = 'child-orphan'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      })

      // 直接从 Redis 删除父任务
      await redis.del(`groupmq:${namespace}-getparent-deleted:job:${parentId}`)

      const childJob = await queue.getJob(childId)
      const parent = await childJob.getParent()

      expect(parent).toBeUndefined()
    })
  })

  describe('Queue.getFlowChildrenIds()', () => {
    it('应该返回父任务的所有子任务 ID', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-flowchildrenids`,
        keepCompleted: 10,
      })

      const parentId = 'parent-ids'
      const child1Id = 'child-id-1'
      const child2Id = 'child-id-2'

      await queue.addFlow({
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

      const ids = await queue.getFlowChildrenIds(parentId)

      expect(ids).toHaveLength(2)
      expect(ids.sort()).toEqual([child1Id, child2Id].sort())
    })

    it('应该为非父任务返回空数组', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-flowchildrenids-empty`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const ids = await queue.getFlowChildrenIds(job.id)

      expect(ids).toEqual([])
    })
  })

  describe('任务流移除时的清理', () => {
    it('应该在父任务被移除时清理子任务集合', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-cleanup-parent`,
        keepCompleted: 10,
      })

      const parentId = 'parent-cleanup'

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          {
            jobId: 'child-cleanup-1',
            groupId: 'g-child',
            data: { name: 'child' },
          },
        ],
      })

      // 验证子任务集合存在
      const childrenKey = `groupmq:${namespace}-cleanup-parent:flow:children:${parentId}`
      let exists = await redis.exists(childrenKey)
      expect(exists).toBe(1)

      // 移除父任务
      const parentJob = await queue.getJob(parentId)
      await parentJob.remove()

      // 验证子任务集合被删除
      exists = await redis.exists(childrenKey)
      expect(exists).toBe(0)
    })

    it('应该在子任务被移除时从父任务的子任务集合中移除子任务', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-cleanup-child`,
        keepCompleted: 10,
      })

      const parentId = 'parent-child-cleanup'
      const child1Id = 'child-to-remove'
      const child2Id = 'child-to-keep'

      await queue.addFlow({
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

      // 验证两个子任务都在集合中
      const childrenKey = `groupmq:${namespace}-cleanup-child:flow:children:${parentId}`
      let members = await redis.smembers(childrenKey)
      expect(members.sort()).toEqual([child1Id, child2Id].sort())

      // 移除一个子任务
      const childJob = await queue.getJob(child1Id)
      await childJob.remove()

      // 验证只有一个子任务保留
      members = await redis.smembers(childrenKey)
      expect(members).toEqual([child2Id])
    })
  })
})

describe('Flow 执行 (父子任务流)', () => {
  let redis2: Redis
  // 使用不同的命名空间前缀，避免与其他测试块冲突
  const namespace = `test:flow:execution:${Date.now()}`

  beforeAll(async () => {
    redis2 = createRedis()
    const keys = await redis2.keys(`${namespace}*`)
    if (keys.length) await redis2.del(keys)
  })

  afterAll(async () => {
    await redis2.quit()
  })

  it('应该在所有子任务完成后才处理父任务', async () => {
    const queue = new Queue({
      redis: redis2,
      namespace,
      logger: true,
      keepCompleted: 10,
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

    // 检查初始状态
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

    // 等待父任务完成（这意味着所有子任务也完成了）
    await parent.waitUntilFinished(5000)

    // 验证所有任务都完成了
    expect((await queue.getJob(child1Id)).status).toBe('completed')
    expect((await queue.getJob(child2Id)).status).toBe('completed')
    expect((await queue.getJob(parentId)).status).toBe('completed')
    expect(await queue.getFlowDependencies(parentId)).toBe(0)

    await worker.close()
  })

  it('应该在子任务完全失败时触发父任务', async () => {
    // 1. 配置队列
    const queue = new Queue({
      redis: redis2,
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

  it('应该通过 getFlowResults 存储和检索子任务结果', async () => {
    const queue = new Queue({
      redis: redis2,
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

  it('应该在子任务进入死信队列时触发父任务', async () => {
    const queue = new Queue({
      redis: redis2,
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
    let worker: Worker | undefined;

    try {
      const queue = new Queue({
        redis: redis2,
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

      worker = new Worker({
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
      await new Promise((resolve) => setTimeout(resolve, 500)) // 等待一下让日志输出

    } catch (err) {
      console.log(err)
    } finally {
      if (worker) await worker.close()
    }

    expect(finalFailedJobs).toContain('parent-job')
    expect(finalFailedJobs).toContain('child-job-1')
    expect(finalFailedJobs).toContain('child-job-2')
  })

  it('应该对流中的父任务和子任务应用 groupConfig', async () => {
    const queue = new Queue({
      redis: redis2,
      namespace: `${namespace}-groupconfig`,
      logger: false,
    })

    const parentGroupId = 'flow-parent-group'
    const child1GroupId = 'flow-child-group-1'
    const child2GroupId = 'flow-child-group-2'

    // 创建具有父任务和子任务 groupConfig 的流
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

    // 验证父任务的 groupConfig 被设置
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(100)
    expect(parentConfig.concurrency).toBe(5)

    // 验证子任务1的 groupConfig 被设置
    const child1Config = await queue.groups.getConfig(child1GroupId)
    expect(child1Config.priority).toBe(50)
    expect(child1Config.concurrency).toBe(2)

    // 验证子任务2的 groupConfig 被设置
    const child2Config = await queue.groups.getConfig(child2GroupId)
    expect(child2Config.priority).toBe(75)
    expect(child2Config.concurrency).toBe(3)

    // 验证流与 groupConfigs 正确协作
    expect(parent.status).toBe('waiting-children')
    const remaining = await queue.getFlowDependencies(parent.id)
    expect(remaining).toBe(2)
  })

  it('应该处理部分 groupConfig 的流（仅父任务）', async () => {
    const queue = new Queue({
      redis: redis2,
      namespace: `${namespace}-partial-config`,
      logger: false,
    })

    const parentGroupId = 'partial-parent-group'
    const childGroupId = 'partial-child-group'

    // 创建仅父任务有 groupConfig 的流
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
          // 子任务没有 groupConfig
        },
      ],
    })

    // 验证父任务的 config 被设置
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(90)

    // 子任务的 groupConfig 应该存在但不包含特殊配置
    const childConfig = await queue.groups.getConfig(childGroupId)
    // childConfig 应该为空或不包含 priority
    expect(childConfig.priority).toBeUndefined()
  })

  it('应该支持自定义 groupConfig 属性，如 weight', async () => {
    const queue = new Queue({
      redis: redis2,
      namespace: `${namespace}-custom-config`,
      logger: false,
    })

    const parentGroupId = 'custom-parent-group'
    const child1GroupId = 'custom-child-group-1'
    const child2GroupId = 'custom-child-group-2'

    // 创建具有自定义 groupConfig 属性（weight）的流
    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: {
          priority: 100,
          concurrency: 5,
          weight: 10, // 自定义属性
          customField: 'custom-value' // 另一个自定义属性
        },
      },
      children: [
        {
          groupId: child1GroupId,
          data: { name: 'child1' },
          groupConfig: {
            priority: 50,
            concurrency: 2,
            weight: 5 // 自定义属性
          },
        },
        {
          groupId: child2GroupId,
          data: { name: 'child2' },
          groupConfig: {
            priority: 75,
            concurrency: 3,
            weight: 8, // 自定义属性
            routingKey: 'route-key' // 另一个自定义属性
          },
        },
      ],
    })

    // 验证父任务的 config 包括自定义属性
    const parentConfig = await queue.groups.getConfig(parentGroupId)
    expect(parentConfig.priority).toBe(100)
    expect(parentConfig.concurrency).toBe(5)
    expect(parentConfig.weight).toBe(10)
    expect(parentConfig.customField).toBe('custom-value')

    // 验证子任务1的 config 包括自定义属性
    const child1Config = await queue.groups.getConfig(child1GroupId)
    expect(child1Config.priority).toBe(50)
    expect(child1Config.concurrency).toBe(2)
    expect(child1Config.weight).toBe(5)

    // 验证子任务2的 config 包括多个自定义属性
    const child2Config = await queue.groups.getConfig(child2GroupId)
    expect(child2Config.priority).toBe(75)
    expect(child2Config.concurrency).toBe(3)
    expect(child2Config.weight).toBe(8)
    expect(child2Config.routingKey).toBe('route-key')

    // 验证流与自定义 configs 正确协作
    expect(parent.status).toBe('waiting-children')
    const remaining = await queue.getFlowDependencies(parent.id)
    expect(remaining).toBe(2)
  })
})

describe('Flow 错误处理 (任务流重试)', () => {
  let redis3: Redis
  // 使用不同的命名空间，防止 Worker 在 cleanup 期间互相干扰
  const namespace = `test:flow:error:${Date.now()}`

  beforeAll(async () => {
    redis3 = createRedis()
    const keys = await redis3.keys(`${namespace}*`)
    if (keys.length) await redis3.del(keys)
  })

  afterAll(async () => {
    await redis3.quit()
  })

  it('确保父任务在子任务重试时依然在所有子任务结束时执行', async () => {
    let execHistory: string[] = []
    let worker: Worker | undefined;

    try {
      const queue = new Queue({
        redis: redis3,
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
          groupConfig: { priority: 10000 }
        },
        children: [
          {
            jobId: 'child-job-1',
            groupId: 'g-child-1',
            data: { name: 'child1' },
            groupConfig: { priority: 10 }
          },
          {
            jobId: 'child-job-2',
            groupId: 'g-child-2',
            data: { name: 'child2' },
            groupConfig: { priority: 10 }
          },
        ],
      })

      worker = new Worker({
        queue,
        concurrency: 1,
        strategy: new PriorityStrategy(),
        backoff: () => 300,
        handler: async (job) => {
          execHistory.push(job.id)
          if (job.isFlowParent) {
            throw new Error(`Parent job ${job.id} failed intentionally`)
          } else {
            throw new Error(`Child job ${job.id} failed intentionally`)
          }
        },
      })

      await parent.waitUntilFinished()

    } catch (err) {
      console.log(err)
    } finally {
      if (worker) await worker.close()
    }

    expect(execHistory).toHaveLength(6)
    expect(execHistory.slice(-2)).toEqual(['parent-job', 'parent-job'])
  }, 5000)
})