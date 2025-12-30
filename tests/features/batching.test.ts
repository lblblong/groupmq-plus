import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

describe('自动批处理 - 简单批处理', () => {
  let redisCleanup: any;

  afterAll(async () => {
    // Clean up with a fresh connection
    redisCleanup = createRedis();
    const keys = await redisCleanup.keys('groupmq:test-autobatch-simple:*');
    if (keys.length > 0) {
      await redisCleanup.del(...keys);
    }
    await redisCleanup.quit();
  });

  it('应在启用 autoBatch 时添加任务', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-simple:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-simple',
      autoBatch: true,
    });

    // Add 5 jobs
    const jobs = await Promise.all([
      queue.add({ groupId: 'g1', data: { index: 0 } }),
      queue.add({ groupId: 'g2', data: { index: 1 } }),
      queue.add({ groupId: 'g3', data: { index: 2 } }),
      queue.add({ groupId: 'g4', data: { index: 3 } }),
      queue.add({ groupId: 'g5', data: { index: 4 } }),
    ]);

    console.log(
      'Jobs added:',
      jobs.map((j) => ({ id: j.id, groupId: j.groupId })),
    );

    // Verify jobs were added
    expect(jobs.length).toBe(5);
    for (const job of jobs) {
      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.groupId).toBeDefined();
    }

    // Verify jobs are in Redis
    const waitingCount = await queue.getWaitingCount();
    console.log('Waiting count:', waitingCount);
    expect(waitingCount).toBe(5);

    await queue.close();
  }, 10000);

  it('应处理批处理任务', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-simple:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-simple',
      autoBatch: true,
    });

    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push(job.id);
      },
      concurrency: 3,
    });

    // Add 10 jobs
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        queue.add({ groupId: `g${i}`, data: { index: i } }),
      ),
    );

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log('Processed:', processed.length);
    expect(processed.length).toBe(10);

    await worker.close();
    await queue.close();
  }, 10000);

  it('无 autoBatch 时应正常工作（基准测试）', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-simple:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-simple',
      // No autoBatch
    });

    // Add 5 jobs
    const jobs = await Promise.all([
      queue.add({ groupId: 'g1', data: { index: 0 } }),
      queue.add({ groupId: 'g2', data: { index: 1 } }),
      queue.add({ groupId: 'g3', data: { index: 2 } }),
      queue.add({ groupId: 'g4', data: { index: 3 } }),
      queue.add({ groupId: 'g5', data: { index: 4 } }),
    ]);

    // Verify jobs were added
    expect(jobs.length).toBe(5);
    for (const job of jobs) {
      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
    }

    // Verify jobs are in Redis
    const waitingCount = await queue.getWaitingCount();
    expect(waitingCount).toBe(5);

    await queue.close();
  }, 10000);
});

describe('自动批处理 - 排序批处理 (orderingDelayMs)', () => {
  let redisCleanup: any;

  afterAll(async () => {
    // Clean up with a fresh connection
    redisCleanup = createRedis();
    const keys = await redisCleanup.keys('groupmq:test-autobatch-ordering:*');
    if (keys.length > 0) {
      await redisCleanup.del(...keys);
    }
    await redisCleanup.quit();
  });

  it('应尊重 autoBatch + orderingDelayMs 下的任务排序', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-ordering:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-ordering',
      autoBatch: true, // Enable batching
      orderingDelayMs: 200, // Wait 200ms to ensure ordering
    });

    const processed: Array<{
      groupId: string;
      index: number;
      orderMs: number;
    }> = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as any;
        processed.push({
          groupId: job.groupId,
          index: data.index,
          orderMs: data.orderMs,
        });
      },
      concurrency: 3,
    });

    // Add 20 jobs for the same group with explicit orderMs
    // These should be batched AND respect ordering
    const baseTime = Date.now();
    const jobPromises = [];

    for (let i = 0; i < 20; i++) {
      jobPromises.push(
        queue.add({
          groupId: 'ordered-group',
          data: { index: i, orderMs: baseTime + i * 10 },
          orderMs: baseTime + i * 10,
        }),
      );
    }

    const jobs = await Promise.all(jobPromises);
    expect(jobs).toHaveLength(20);

    console.log(
      'Added 20 jobs with autoBatch + orderingDelayMs. Batches created:',
      Math.ceil(20 / 10),
    );

    // Check that jobs are in staged status initially
    const stagedCount = await redis.zcard(
      'groupmq:test-autobatch-ordering:stage',
    );
    console.log('Jobs in staging:', stagedCount);
    expect(stagedCount).toBe(20);

    // Wait for orderingDelayMs + processing time
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify all jobs were processed in correct order
    expect(processed.length).toBe(20);

    console.log('First 5 processed:', processed.slice(0, 5));
    console.log('Last 5 processed:', processed.slice(-5));

    // All should be from same group and in order
    for (let i = 0; i < processed.length; i++) {
      expect(processed[i].groupId).toBe('ordered-group');
      expect(processed[i].index).toBe(i);
      if (i > 0) {
        // Each job's orderMs should be greater than previous
        expect(processed[i].orderMs).toBeGreaterThan(processed[i - 1].orderMs);
      }
    }

    console.log(
      '✅ All jobs processed in correct order with batching + staging!',
    );

    await worker.close();
    await queue.close();
  }, 15000);

  it('应处理混合的暂存和即时任务', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-ordering:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-ordering',
      autoBatch: true,
      orderingDelayMs: 200,
    });

    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push(job.id);
      },
      concurrency: 3,
    });

    const baseTime = Date.now();

    // Add jobs: some with orderMs (staged), some without (immediate)
    const jobPromises = [
      // These will be staged
      queue.add({
        groupId: 'g1',
        data: { type: 'staged' },
        orderMs: baseTime + 100,
      }),
      queue.add({
        groupId: 'g2',
        data: { type: 'staged' },
        orderMs: baseTime + 200,
      }),
      // These will be immediate (no orderMs, defaults to Date.now())
      queue.add({ groupId: 'g3', data: { type: 'immediate' } }),
      queue.add({ groupId: 'g4', data: { type: 'immediate' } }),
    ];

    await Promise.all(jobPromises);

    // Wait for all jobs (immediate + staged with orderingDelayMs)
    await new Promise((resolve) => setTimeout(resolve, 800));

    // All jobs should be processed now
    expect(processed.length).toBe(4);
    console.log('All jobs processed:', processed.length);

    console.log('✅ Mixed immediate and staged jobs with batching works!');

    await worker.close();
    await queue.close();
  }, 15000);

  it('应使用 orderingDelayMs 批处理多个组', async () => {
    const redis = createRedis();

    // Clean up first
    const keys = await redis.keys('groupmq:test-autobatch-ordering:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const queue = new Queue({
      redis,
      namespace: 'test-autobatch-ordering',
      autoBatch: { size: 20, maxWaitMs: 50 }, // Large batch
      orderingDelayMs: 100,
    });

    const processed: Record<string, number[]> = {};

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as any;
        if (!processed[job.groupId]) {
          processed[job.groupId] = [];
        }
        processed[job.groupId].push(data.index);
      },
      concurrency: 5,
    });

    // Add 30 jobs across 3 groups (10 per group)
    const baseTime = Date.now();
    const jobPromises = [];

    for (let groupIdx = 0; groupIdx < 3; groupIdx++) {
      const groupId = `group-${groupIdx}`;
      for (let i = 0; i < 10; i++) {
        jobPromises.push(
          queue.add({
            groupId,
            data: { index: i, orderMs: baseTime + i * 10 },
            orderMs: baseTime + i * 10,
          }),
        );
      }
    }

    const jobs = await Promise.all(jobPromises);
    expect(jobs).toHaveLength(30);

    console.log('Added 30 jobs across 3 groups. Batches:', Math.ceil(30 / 20));

    // Wait for staging + processing (orderingDelayMs=100 + processing time)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    console.log('Processed groups:', Object.keys(processed));
    console.log(
      'Group counts:',
      Object.fromEntries(
        Object.entries(processed).map(([k, v]) => [k, v.length]),
      ),
    );

    // Verify all groups processed correctly
    expect(Object.keys(processed)).toHaveLength(3);
    expect(processed['group-0']).toHaveLength(10);
    expect(processed['group-1']).toHaveLength(10);
    expect(processed['group-2']).toHaveLength(10);

    // Verify order within each group
    for (const groupId of Object.keys(processed)) {
      const indices = processed[groupId];
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    }

    console.log('✅ Multiple groups batched and ordered correctly!');

    await worker.close();
    await queue.close();
  }, 15000);
});
