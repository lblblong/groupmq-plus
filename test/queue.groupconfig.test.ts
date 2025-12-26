import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Queue } from '../src/queue'
import { createRedis } from './helpers/redis'

describe('GroupConfig in add() method', () => {
  const namespace = `test:groupconfig:${Date.now()}`
  let queue: Queue

  beforeAll(async () => {
    const redis = createRedis()
    queue = new Queue({ redis, namespace })
  })

  afterAll(async () => {
    await queue.close()
    const redis = createRedis()
    const keys = await redis.keys(`${namespace}*`)
    if (keys.length) await redis.del(keys)
    await redis.quit()
  })

  it('should set group config atomically when adding a job', async () => {
    // Add a job with groupConfig
    const job = await queue.add({
      groupId: 'test-group',
      data: { test: 'data' },
      groupConfig: { priority: 100, concurrency: 5 }
    })

    expect(job.id).toBeDefined()

    // Verify the config was set
    const config = await queue.groups.getConfig('test-group')
    expect(config.priority).toBe(100)
    expect(config.concurrency).toBe(5)
  })

  it('should use queue.groups.setConfig for manual configuration', async () => {
    await queue.groups.setConfig('manual-group', { priority: 50, concurrency: 2 })

    const config = await queue.groups.getConfig('manual-group')
    expect(config.priority).toBe(50)
    expect(config.concurrency).toBe(2)
  })

  it('should use queue.groups.setConcurrency for quick concurrency adjustment', async () => {
    await queue.groups.setConcurrency('quick-group', 10)

    const config = await queue.groups.getConfig('quick-group')
    expect(config.concurrency).toBe(10)
  })

  it('should support deprecated methods for backward compatibility', async () => {
    // Test deprecated setGroupConfig
    await queue.groups.setConfig('deprecated-group', { priority: 25 })

    const config = await queue.groups.getConfig('deprecated-group')
    expect(config.priority).toBe(25)

    // Test deprecated setGroupConcurrency
    await queue.groups.setConcurrency('deprecated-group', 3)
    const concurrency = await queue.groups.getConcurrency('deprecated-group')
    expect(concurrency).toBe(3)
  })
})
