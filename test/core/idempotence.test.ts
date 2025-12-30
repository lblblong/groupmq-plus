import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

describe('幂等性入队 - 可选 jobId', () => {
  const namespace = `test:idempotence:${Date.now()}`;

  afterAll(async () => {
    const redis = createRedis();
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  });

  it('应忽略具有相同 jobId 的重复添加并返回相同 id', async () => {
    const redis = createRedis();
    const q = new Queue({ redis, namespace: `${namespace}:dedupe` });

    const customId = 'my-fixed-id';

    const job1 = await q.add({
      groupId: 'g1',
      data: { n: 1 },
      jobId: customId,
    });
    const job2 = await q.add({
      groupId: 'g1',
      data: { n: 2 },
      jobId: customId,
    });

    expect(job1.id).toBe(customId);
    expect(job2.id).toBe(customId);

    // Process and ensure only one job is executed
    const processed: any[] = [];
    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data as any);
      },
    });
    worker.run();

    await q.waitForEmpty();

    expect(processed.length).toBe(1);
    expect(processed[0]).toEqual({ n: 1 });

    await worker.close();
    await redis.quit();
  });

  it('未提供 jobId 时应生成 UUID', async () => {
    const redis = createRedis();
    const q = new Queue({ redis, namespace: `${namespace}:uuid` });

    const job = await q.add({ groupId: 'g1', data: { a: 1 } });

    // UUID v4 shape check (8-4-4-4-12 hex)
    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const processed: any[] = [];
    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.id);
      },
    });
    worker.run();

    await q.waitForEmpty();

    expect(processed).toEqual([job.id]);

    await worker.close();
    await redis.quit();
  });

  it('任务被保留策略删除后应允许 jobId 重用', async () => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `${namespace}:reuse`,
      keepCompleted: 0,
      keepFailed: 0,
    });

    const customId = 'reusable-id';

    const job = await q.add({
      groupId: 'g1',
      data: { n: 1 },
      jobId: customId,
    });
    expect(job.id).toBe(customId);

    // Process first job
    const processed: any[] = [];
    const worker1 = new Worker({
      name: 'worker1',
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push({
          ...job.data,
          worker: 'worker1',
        });
      },
    });
    worker1.run();

    await q.waitForEmpty();
    await worker1.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // At this point, keepCompleted:0 should have removed job and unique mapping
    const job2 = await q.add({
      groupId: 'g1',
      data: { n: 2 },
      jobId: customId,
    });
    expect(job2.id).toBe(customId);

    // Process second job
    const worker2 = new Worker({
      name: 'worker2',
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push({
          ...job.data,
          worker: 'worker2',
        });
      },
    });
    worker2.run();

    await q.waitForEmpty();
    await worker2.close();

    // Verify both jobs were processed correctly
    expect(processed).toEqual([
      { n: 1, worker: 'worker1' },
      { n: 2, worker: 'worker2' },
    ]);

    await redis.quit();
  });
});
