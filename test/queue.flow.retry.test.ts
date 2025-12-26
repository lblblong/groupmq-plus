import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PriorityStrategy, Queue, Worker } from '../src'
import { createRedis } from './helpers/redis'

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

  it('确保父任务在子任务重试时依然在所有子任务结束时执行', async () => {
    let execHistory: string[] = []
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

      const worker = new Worker({
        queue,
        concurrency: 1,
        strategy: new PriorityStrategy({
          algorithm: { type: 'strict' },
          onGetPriority: (groupId, config) => {
            // 确保该父任务所有子任务结束后立即执行父任务
            if (groupId.startsWith('g-parent')) {
              return 10000
            }
            return 10
          },
        }),
        backoff: () => 1000,
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
      await worker.close()
    } catch (err) {
      console.log(err)
    }

    expect(execHistory).toEqual([
      'child-job-1',
      'child-job-1',
      'child-job-2',
      'child-job-2',
      'parent-job',
      'parent-job',
    ])
  })
})

