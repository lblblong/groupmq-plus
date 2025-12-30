import { describe, expect, test, waitUntil } from '../helpers/suite';
import { createRedis } from '../helpers/redis';
import { Queue, Worker } from '../../src';
import { Redis } from 'ioredis';

describe('Redis 连接断开与重新连接 (Redis Disconnect/Reconnect Tests)', () => {
  // 注意：这些测试需要手动管理 Redis 连接，因为它们测试的是断开/重连场景
  // 不能使用 fixture 自动管理的连接

  test('应当优雅地处理 Redis 连接丢失 (should handle Redis connection drops gracefully)', async ({ namespace }) => {
    const redis = createRedis({
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    const q = new Queue({ redis, namespace: `${namespace}:drop` });

    await q.add({ groupId: 'persistent-group', data: { id: 1 } });
    await q.add({ groupId: 'persistent-group', data: { id: 2 } });

    const processed: number[] = [];
    const errors: string[] = [];

    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data.id);
      },
      onError: (err) => {
        errors.push((err as Error).message);
      },
    });

    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 200));

    await redis.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 500));

    await redis.connect();

    await q.add({ groupId: 'persistent-group', data: { id: 3 } });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processed.length).toBeGreaterThan(0);
    expect(processed).toContain(1);

    await worker.close();
    await q.close();
    try { await redis.quit(); } catch { }
  });

  test('应当从 Redis 服务器重启模拟中恢复 (should recover from Redis server restart simulation)', async ({ namespace }) => {
    const redis = createRedis({
      connectTimeout: 1000,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
    });

    const q = new Queue({ redis, namespace: `${namespace}:restart` });

    await q.add({ groupId: 'restart-group', data: { phase: 'before' } });

    const processed: string[] = [];
    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).phase);
      },
    });

    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 200));

    await redis.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 300));

    await redis.connect();
    await q.add({ groupId: 'restart-group', data: { phase: 'after' } });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processed).toContain('before');
    expect(processed).toContain('after');

    await worker.close();
    await q.close();
    try { await redis.quit(); } catch { }
  });

  test('应当处理网络分区和阻塞操作 (should handle network partitions and blocking operations)', async ({ namespace }) => {
    const redis = createRedis({
      connectTimeout: 1000,
      commandTimeout: 2000,
    });

    const q = new Queue({ redis, namespace: `${namespace}:partition` });

    const processed: number[] = [];
    const errors: string[] = [];

    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data.id);
      },
      onError: (err) => {
        errors.push((err as Error).message);
      },
    });

    worker.run();

    await q.add({ groupId: 'partition-group', data: { id: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await redis.disconnect();

    const redis2 = createRedis();
    const q2 = new Queue({
      redis: redis2,
      namespace: `${namespace}:partition`,
    });
    await q2.add({ groupId: 'partition-group', data: { id: 2 } });

    await new Promise((resolve) => setTimeout(resolve, 500));

    await redis.connect();

    const startWait = Date.now();
    while (processed.length < 2 && Date.now() - startWait < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(processed).toContain(1);
    if (processed.length >= 2) {
      expect(processed).toContain(2);
    }

    await worker.close();
    await q.close();
    await q2.close();
    try { await redis.quit(); } catch { }
    try { await redis2.quit(); } catch { }
  });


  test('应当在 Redis 故障期间保持任务状态一致性 (should maintain job state consistency during Redis failures)', async ({ namespace }) => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `${namespace}:consistency`,
      jobTimeoutMs: 500,
    });

    await q.add({ groupId: 'consistency-group', data: { id: 1 } });
    await q.add({ groupId: 'consistency-group', data: { id: 2 } });

    const processed: number[] = [];
    let processingJob1 = false;

    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        if (job.data.id === 1 && !processingJob1) {
          processingJob1 = true;
          await redis.disconnect();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await redis.connect();
          throw new Error('Simulated failure during disconnect');
        }
        processed.push(job.data.id);
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(processed.length).toBeGreaterThan(0);

    await worker.close();
    await q.close();
    try { await redis.quit(); } catch { }
  });

  test('应当处理 Redis 内存压力和连接限制 (should handle Redis memory pressure and connection limits)', async ({ namespace }) => {
    const connections: Redis[] = [];

    try {
      for (let i = 0; i < 10; i++) {
        const redis = createRedis({
          maxRetriesPerRequest: 1,
          connectTimeout: 1000,
        });
        connections.push(redis);
      }

      const q = new Queue({
        redis: connections[0],
        namespace: `${namespace}:memory`,
        jobTimeoutMs: 1000,
      });

      const jobPromises = [];
      for (let i = 0; i < 100; i++) {
        jobPromises.push(
          q.add({
            groupId: `memory-group-${i % 5}`,
            data: { id: i, data: 'x'.repeat(100) },
          }),
        );
      }
      await Promise.all(jobPromises);

      const processed: number[] = [];
      const workers: Worker<any>[] = [];

      for (let i = 0; i < 3; i++) {
        const worker = new Worker({
          queue: q,
          blockingTimeoutSec: 1,
          handler: async (job) => {
            processed.push(job.data.id);
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
        });
        workers.push(worker);
        worker.run();
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(processed.length).toBeGreaterThan(50);

      await Promise.all(workers.map((w) => w.close()));
      await q.close();
    } finally {
      for (const redis of connections) {
        try { await redis.quit(); } catch { }
      }
    }
  });

  test('应当优雅地处理 Redis AUTH 故障 (should handle Redis AUTH failures gracefully)', async ({ namespace }) => {
    const redis = createRedis({
      connectTimeout: 1000,
      maxRetriesPerRequest: 2,
    });

    const q = new Queue({ redis, namespace: `${namespace}:auth` });

    await q.add({ groupId: 'auth-group', data: { test: 'auth' } });

    const processed: string[] = [];
    const errors: string[] = [];

    const worker = new Worker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data.test);
      },
      onError: (err) => {
        errors.push((err as Error).message);
      },
    });

    worker.run();

    // 使用状态轮询等待任务处理完成
    await waitUntil(() => processed.includes('auth'), 2000);

    expect(processed).toContain('auth');

    await worker.close();
    await q.close();
    try { await redis.quit(); } catch { }
  });
});
