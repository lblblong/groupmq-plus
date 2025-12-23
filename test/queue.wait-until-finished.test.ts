import { describe, expect, it } from 'vitest';
import { Queue, Worker } from '../src';
import { cleanupRedis, createRedis } from './helpers/redis';

describe('waitUntilFinished', () => {
  it('resolves when a job completes', async () => {
    const redis = createRedis();
    const q = new Queue<{ value: number }>({
      redis,
      namespace: `test:wait-complete:${Date.now()}`,
      keepCompleted: 1,
    });

    const worker = new Worker<{ value: number }>({
      queue: q,
      handler: async (job) => job.data.value * 2,
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: { value: 21 } });

    const result = await job.waitUntilFinished(2000);
    expect(result).toBe(42);

    await worker.close();
    await q.close();
    await cleanupRedis(q.namespace);
  });

  it('rejects when a job fails', async () => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `test:wait-fail:${Date.now()}`,
      keepFailed: 1,
      maxAttempts: 1,
    });

    const worker = new Worker({
      queue: q,
      handler: async () => {
        throw new Error('boom');
      },
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: { value: 1 } });

    await expect(job.waitUntilFinished(5000)).rejects.toThrow('boom');

    await worker.close();
    await q.close();
    await cleanupRedis(q.namespace);
  });

  it('resolves multiple concurrent waiters for the same job', async () => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `test:wait-multi:${Date.now()}`,
      keepCompleted: 1,
    });

    const worker = new Worker({
      queue: q,
      handler: async () => 'ok',
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: {} });

    const waiter1 = job.waitUntilFinished(2000);
    const waiter2 = q.waitUntilFinished(job.id, 2000);

    const [result1, result2] = await Promise.all([waiter1, waiter2]);
    expect(result1).toBe('ok');
    expect(result2).toBe('ok');

    await worker.close();
    await q.close();
    await cleanupRedis(q.namespace);
  });
});
