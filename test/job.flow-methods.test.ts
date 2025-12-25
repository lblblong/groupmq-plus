import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Queue, Worker } from '../src'
import { createRedis } from './helpers/redis'

describe('Job Flow Methods', () => {
  const redis = createRedis()
  const namespace = `test:job-flow-methods:${Date.now()}`

  beforeAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`)
    if (keys.length) await redis.del(keys)
  })

  afterAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`)
    if (keys.length) await redis.del(keys)
    await redis.quit()
  })

  describe('parentId property', () => {
    it('should have parentId set for child jobs', async () => {
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

    it('should have undefined parentId for non-child jobs', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-no-parent`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      expect(job.parentId).toBeUndefined()
    })

    it('should have undefined parentId for parent jobs', async () => {
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
    it('should return all child jobs for a parent', async () => {
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

    it('should return empty array for jobs with no children', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getchildren-empty`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const children = await job.getChildren()

      expect(children).toEqual([])
    })

    it('should skip deleted child jobs gracefully', async () => {
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

      // Delete one child directly from Redis (simulating cleanup)
      await redis.del(
        `groupmq:${namespace}-getchildren-deleted:job:${child1Id}`
      )

      const parentJob = await queue.getJob(parentId)
      const children = await parentJob.getChildren()

      // Should only return the remaining child
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe(child2Id)
    })
  })

  describe('getChildrenValues()', () => {
    it('should return child job results', async () => {
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

      // Wait for processing
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

    it('should return empty object for jobs with no children', async () => {
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
    it('should return correct count of remaining children', async () => {
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

    it('should return null for non-parent jobs', async () => {
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
    it('should return parent job for child jobs', async () => {
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

    it('should return undefined for jobs with no parent', async () => {
      const queue = new Queue({
        redis,
        namespace: `${namespace}-getparent-undefined`,
        keepCompleted: 10,
      })

      const job = await queue.add({ groupId: 'g1', data: { test: true } })
      const parent = await job.getParent()

      expect(parent).toBeUndefined()
    })

    it('should return undefined when parent is deleted', async () => {
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

      // Delete parent directly from Redis
      await redis.del(`groupmq:${namespace}-getparent-deleted:job:${parentId}`)

      const childJob = await queue.getJob(childId)
      const parent = await childJob.getParent()

      expect(parent).toBeUndefined()
    })
  })

  describe('Queue.getFlowChildrenIds()', () => {
    it('should return all child IDs for a parent', async () => {
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

    it('should return empty array for non-parent jobs', async () => {
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

  describe('Flow cleanup on remove', () => {
    it('should clean up children set when parent is removed', async () => {
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

      // Verify children set exists
      const childrenKey = `groupmq:${namespace}-cleanup-parent:flow:children:${parentId}`
      let exists = await redis.exists(childrenKey)
      expect(exists).toBe(1)

      // Remove parent
      const parentJob = await queue.getJob(parentId)
      await parentJob.remove()

      // Verify children set is deleted
      exists = await redis.exists(childrenKey)
      expect(exists).toBe(0)
    })

    it('should remove child from parent children set when child is removed', async () => {
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

      // Verify both children are in set
      const childrenKey = `groupmq:${namespace}-cleanup-child:flow:children:${parentId}`
      let members = await redis.smembers(childrenKey)
      expect(members.sort()).toEqual([child1Id, child2Id].sort())

      // Remove one child
      const childJob = await queue.getJob(child1Id)
      await childJob.remove()

      // Verify only one child remains
      members = await redis.smembers(childrenKey)
      expect(members).toEqual([child2Id])
    })
  })
})

