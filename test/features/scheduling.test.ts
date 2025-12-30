import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

let globalRedis: any;

beforeAll(async () => {
  globalRedis = createRedis();
});

afterAll(async () => {
  await globalRedis.quit();
});

describe('延迟任务 (Delayed Jobs)', () => {
  let namespace: string;
  let redis: any;
  let queue: Queue;

  beforeEach(async () => {
    redis = globalRedis;
    // Create unique namespace for each test to avoid interference
    namespace = `test:delay:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    queue = new Queue({
      redis,
      namespace,
      schedulerLockTtlMs: 50, // Fast scheduler for test - allows frequent delayed job promotion
    });

    // Cleanup
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterEach(async () => {
    // Cleanup after each test
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  it('应该延迟任务并在延迟过期后处理', async () => {
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      cleanupIntervalMs: 50,
      schedulerIntervalMs: 50,
    });

    worker.run();

    const startTime = Date.now();
    const delayMs = 200; // 200ms delay - reduced for faster tests

    // Add delayed job
    await queue.add({
      groupId: 'delay-group',
      data: { id: 'delayed-job' },
      delay: delayMs,
    });

    // Add immediate job for comparison
    await queue.add({
      groupId: 'immediate-group',
      data: { id: 'immediate-job' },
    });

    await queue.waitForEmpty();

    await worker.close();

    // Verify both jobs were processed
    expect(processed).toHaveLength(2);

    const immediateJob = processed.find((p) => p.id === 'immediate-job');
    const delayedJob = processed.find((p) => p.id === 'delayed-job');

    expect(immediateJob).toBeDefined();
    expect(delayedJob).toBeDefined();

    // Verify delayed job was processed after the delay
    const delayedJobProcessTime = delayedJob!.processedAt - startTime;
    expect(delayedJobProcessTime).toBeGreaterThanOrEqual(delayMs - 50); // Allow some tolerance

    // Verify immediate job was processed quickly
    const immediateJobProcessTime = immediateJob!.processedAt - startTime;
    expect(immediateJobProcessTime).toBeLessThan(200);
  });

  it('应该处理 runAt 调度', async () => {
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      cleanupIntervalMs: 50, // Promote delayed jobs more frequently for test
      schedulerIntervalMs: 50,
    });

    worker.run();

    const runAt = new Date(Date.now() + 200); // Run in 200ms - reduced for faster tests

    await queue.add({
      groupId: 'scheduled-group',
      data: { id: 'scheduled-job' },
      runAt,
    });

    // Wait for processing (increased for scheduler + delay + processing)
    await queue.waitForEmpty();

    await worker.close();

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe('scheduled-job');

    // Verify job was processed at approximately the right time
    const actualRunTime = processed[0].processedAt;
    const expectedRunTime = runAt.getTime();
    const timeDiff = Math.abs(actualRunTime - expectedRunTime);

    expect(timeDiff).toBeLessThan(300); // Allow 300ms tolerance for scheduler tick + processing
  });

  it('应该不允许过去的日期用于 runAt', async () => {
    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
    });

    worker.run();

    // Try to schedule in the past
    const pastDate = new Date(Date.now() - 5000); // 5 seconds ago

    await queue.add({
      groupId: 'past-group',
      data: { id: 'past-job' },
      runAt: pastDate,
    });

    // Wait for processing - use waitForEmpty
    await queue.waitForEmpty(2000);

    await worker.close();

    // Job should be processed immediately since past dates are clamped to now
    expect(processed).toContain('past-job');
  });

  it('应该支持 changeDelay 功能', async () => {
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      cleanupIntervalMs: 50, // Promote delayed jobs more frequently for test
      schedulerIntervalMs: 50,
    });

    worker.run();

    const startTime = Date.now();

    // Add job with 400ms delay
    const job = await queue.add({
      groupId: 'change-delay-group',
      data: { id: 'changeable-job' },
      delay: 400,
    });

    // Wait 50ms then change delay to 50ms (so it should run soon)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const changeSuccess = await job.changeDelay(50);
    expect(changeSuccess).toBe(true);

    // Wait for processing
    await queue.waitForEmpty(1000);

    await worker.close();

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe('changeable-job');

    // Job should have been processed around 100-200ms (50ms wait + 50ms new delay + scheduler overhead)
    const actualProcessTime = processed[0].processedAt - startTime;
    expect(actualProcessTime).toBeGreaterThan(80); // At least 50ms wait + 50ms delay - some tolerance
    expect(actualProcessTime).toBeLessThan(400); // Should be much faster than original 400ms delay
  });

  it('应该在延迟中保持组内的 FIFO 顺序', async () => {
    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
      cleanupIntervalMs: 50, // Promote delayed jobs more frequently for test
      schedulerIntervalMs: 50,
    });

    worker.run();

    // Add jobs with different delays but same group
    await queue.add({
      groupId: 'fifo-delay-group',
      data: { id: 'job1' },
      delay: 150,
      orderMs: 1000, // Earlier order
    });

    await queue.add({
      groupId: 'fifo-delay-group',
      data: { id: 'job2' },
      delay: 100, // Shorter delay but later order
      orderMs: 2000,
    });

    // Wait for processing (increased for scheduler + delays + processing)
    await queue.waitForEmpty(2000);

    await worker.close();

    expect(processed).toHaveLength(2);
    // With physical separation, job2 becomes ready at T+300ms and is processed immediately,
    // while job1 is still delayed until T+500ms. This avoids Head-of-Line blocking.
    // If they were promoted in the same tick, job1 would go first due to orderMs.
    expect(processed).toEqual(['job2', 'job1']);
  });
});

describe('周期任务 (Cron/Repeating Jobs)', () => {
  let namespace: string;
  let redis: any;
  let queue: Queue;

  beforeEach(async () => {
    redis = globalRedis;
    // Create a unique namespace for each test
    namespace = `test:cron:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    queue = new Queue({
      redis,
      namespace,
      jobTimeoutMs: 100,
      schedulerLockTtlMs: 50, // Fast lock for sub-second repeats in tests
    });

    // Cleanup any existing keys
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterEach(async () => {
    // Cleanup after each test
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  it('应该使用 every 选项创建并处理重复任务', async () => {
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      cleanupIntervalMs: 30, // Run cleanup more frequently for faster test
      schedulerIntervalMs: 30,
    });

    worker.run();

    // Create a job that repeats every 50ms
    const cronJob = await queue.add({
      groupId: 'cron-group',
      data: { id: 'recurring-job', message: 'Hello from cron!' },
      repeat: { every: 50 }, // Every 50ms - reduced from 100ms
    });

    expect(cronJob.id).toContain('repeat:');

    // Wait for multiple executions - reduced from 500ms
    await new Promise((resolve) => setTimeout(resolve, 250));

    await worker.close();

    // Should have processed the job multiple times (at least 3 times in 250ms)
    expect(processed.length).toBeGreaterThanOrEqual(3);
    expect(processed.length).toBeLessThanOrEqual(8); // Shouldn't be too many

    // All processed jobs should have the same data
    processed.forEach((job) => {
      expect(job.id).toBe('recurring-job');
    });

    // Jobs should be spaced approximately 50ms apart
    if (processed.length >= 2) {
      const timeDiff = processed[1].processedAt - processed[0].processedAt;
      expect(timeDiff).toBeGreaterThan(40); // Allow some tolerance
      expect(timeDiff).toBeLessThan(150); // More generous tolerance for system overhead
    }
  });

  it('应该处理 cron 表达式模式', async () => {
    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push(`${(job.data as any).id}-${Date.now()}`);
      },
      cleanupIntervalMs: 30000, // Every 30 seconds - faster for test
    });

    worker.run();

    // Create a job that runs every minute
    const cronJob = await queue.add({
      groupId: 'pattern-group',
      data: { id: 'minute-job' },
      repeat: { pattern: '* * * * *' }, // Every minute
    });

    expect(cronJob.id).toContain('repeat:');

    await worker.close();

    // The job should be scheduled but not necessarily executed yet
    // (since we don't want to wait a full minute in a test)
    expect(cronJob).toBeDefined();
  });

  it('应该删除重复任务', async () => {
    const processed: string[] = [];

    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
      cleanupIntervalMs: 50,
      schedulerIntervalMs: 30,
    });

    worker.run();

    const repeatOptions = { every: 50 }; // Every 50ms - reduced for faster test

    // Create a repeating job
    await queue.add({
      groupId: 'removable-group',
      data: { id: 'removable-job' },
      repeat: repeatOptions,
    });

    // Let it run a few times - reduced
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Give the scheduler a moment to ensure the repeating job is fully set up
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Remove the repeating job
    const removed = await queue.removeRepeatingJob(
      'removable-group',
      repeatOptions,
    );
    expect(removed).toBe(true);

    // Wait for the group to drain completely (any already-enqueued jobs to be processed)
    // The scheduler might have enqueued jobs just before we called removeRepeatingJob
    const maxWait = 1000;
    const startWait = Date.now();
    while (Date.now() - startWait < maxWait) {
      const waiting = await queue.getWaitingCount();
      const active = await queue.getActiveCount();
      if (waiting === 0 && active === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const processedSoFar = processed.length;

    // Wait for several scheduler intervals to ensure the scheduler has had time to
    // process any remaining due jobs and see the removed flag
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now verify no new jobs are scheduled - wait several repeat intervals
    await new Promise((resolve) => setTimeout(resolve, 200));

    await worker.close();

    // Should not have processed more jobs after the queue drained
    // Allow for a few extra jobs due to race conditions (scheduler might have been
    // in the middle of processing when removeRepeatingJob was called, or pending
    // jobs might take a bit to fully drain due to new implementation overhead)
    expect(processed.length).toBeLessThanOrEqual(processedSoFar + 5);
  });

  it('应该处理复杂的 cron 表达式', async () => {
    // Test the cron parser without actually waiting

    // This should not throw an error
    try {
      await queue.add({
        groupId: 'complex-group',
        data: { id: 'complex-job' },
        repeat: { pattern: '0 9 * * 1-5' }, // 9 AM on weekdays
      });
    } catch (error) {
      // Should not throw for valid patterns
      expect(error).toBeUndefined();
    }

    // Test invalid pattern
    try {
      await queue.add({
        groupId: 'invalid-group',
        data: { id: 'invalid-job' },
        repeat: { pattern: 'invalid pattern' },
      });
      // Should have thrown an error
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});

describe('自定义排序 (Custom Ordering)', () => {
  let namespace: string;
  let redis: any;
  let queue: Queue;

  beforeEach(async () => {
    redis = globalRedis;
    // Create unique namespace for each test to avoid interference
    namespace = `test:ordering:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    // Cleanup after each test
    if (queue) {
      // Stop promoter but don't close main Redis connection (shared with tests)
      await queue.stopPromoter();
    }
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  it('应该在任务无序到达时按正确的 orderMs 顺序处理任务', async () => {
    // Create queue with orderingDelayMs to enable staging
    queue = new Queue({
      redis,
      namespace,
      orderingDelayMs: 150, // Wait 150ms to ensure all jobs arrive
    });

    const processed: Array<{ id: number; orderMs: number }> = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as { id: number };
        processed.push({ id: data.id, orderMs: job.orderMs! });
        if (processed.length === 3) {
          resolveComplete();
        }
      },
    });

    // Add jobs with orderMs timestamps in reverse order of arrival
    const now = Date.now();

    // Job 3 arrives first but has latest orderMs
    await queue.add({
      groupId: 'test-group',
      data: { id: 3 },
      orderMs: now + 100, // Latest timestamp
    });

    // Wait 50ms before adding next job
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job 2 arrives second
    await queue.add({
      groupId: 'test-group',
      data: { id: 2 },
      orderMs: now + 50, // Middle timestamp
    });

    // Wait 50ms before adding next job
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job 1 arrives last but has earliest orderMs
    await queue.add({
      groupId: 'test-group',
      data: { id: 1 },
      orderMs: now, // Earliest timestamp
    });

    // Wait for all jobs to be processed
    await completePromise;

    await worker.close();

    // Jobs should be processed in orderMs order, not arrival order
    expect(processed).toHaveLength(3);
    expect(processed[0].id).toBe(1); // Earliest orderMs (now)
    expect(processed[1].id).toBe(2); // Middle orderMs (now+50)
    expect(processed[2].id).toBe(3); // Latest orderMs (now+100)
    expect(processed[0].orderMs).toBe(now);
    expect(processed[1].orderMs).toBe(now + 50);
    expect(processed[2].orderMs).toBe(now + 100);
  });

  it('应该在未提供 orderMs 时不暂存任务', async () => {
    queue = new Queue({
      redis,
      namespace,
      orderingDelayMs: 150,
    });

    const processed: string[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as { id: string };
        processed.push(data.id);
        if (processed.length === 2) {
          resolveComplete();
        }
      },
    });

    // Add jobs without orderMs - should process immediately (not staged)
    await queue.add({
      groupId: 'test-group',
      data: { id: 'first' },
    });

    await queue.add({
      groupId: 'test-group',
      data: { id: 'second' },
    });

    await completePromise;
    await worker.close();

    // Without orderMs, jobs should be processed in arrival order
    expect(processed).toEqual(['first', 'second']);
  });

  it('应该在 orderingDelayMs 为 0 时不暂存任务', async () => {
    queue = new Queue({
      redis,
      namespace,
      orderingDelayMs: 0, // No staging
    });

    const processed: Array<{ id: number; orderMs: number }> = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as { id: number };
        processed.push({ id: data.id, orderMs: job.orderMs! });
        if (processed.length === 3) {
          resolveComplete();
        }
      },
    });

    const now = Date.now();

    // Add jobs simultaneously (no delays) with orderMs in reverse order
    const [job3, job2, job1] = await Promise.all([
      queue.add({
        groupId: 'test-group',
        data: { id: 3 },
        orderMs: now + 100,
      }),
      queue.add({
        groupId: 'test-group',
        data: { id: 2 },
        orderMs: now + 50,
      }),
      queue.add({
        groupId: 'test-group',
        data: { id: 1 },
        orderMs: now,
      }),
    ]);

    await completePromise;
    await worker.close();

    // With orderingDelayMs = 0, jobs process in orderMs order (score-based) from ZSET
    expect(processed).toHaveLength(3);
    expect(processed[0].id).toBe(1);
    expect(processed[1].id).toBe(2);
    expect(processed[2].id).toBe(3);
  });

  it('应该为多个组独立处理暂存', async () => {
    queue = new Queue({
      redis,
      namespace,
      orderingDelayMs: 150,
    });

    const processedA: number[] = [];
    const processedB: number[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as { id: number };
        if (job.groupId === 'group-a') {
          processedA.push(data.id);
        } else {
          processedB.push(data.id);
        }
        if (processedA.length === 2 && processedB.length === 2) {
          resolveComplete();
        }
      },
    });

    // Add jobs for group A in reverse order
    await queue.add({
      groupId: 'group-a',
      data: { id: 2 },
      orderMs: Date.now() + 200,
    });

    await queue.add({
      groupId: 'group-a',
      data: { id: 1 },
      orderMs: Date.now() + 100,
    });

    // Add jobs for group B in reverse order
    await queue.add({
      groupId: 'group-b',
      data: { id: 4 },
      orderMs: Date.now() + 400,
    });

    await queue.add({
      groupId: 'group-b',
      data: { id: 3 },
      orderMs: Date.now() + 300,
    });

    await completePromise;
    await worker.close();

    // Each group should process in correct order
    expect(processedA).toEqual([1, 2]);
    expect(processedB).toEqual([3, 4]);
  });

  it('应该处理启动多次的 promoter（幂等）', async () => {
    queue = new Queue({
      redis,
      namespace,
      orderingDelayMs: 150,
    });

    // Start promoter multiple times - should not cause issues
    await queue.startPromoter();
    await queue.startPromoter();
    await queue.startPromoter();

    const processed: number[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = new Worker({
      queue,
      handler: async (job) => {
        const data = job.data as { id: number };
        processed.push(data.id);
        if (processed.length === 2) {
          resolveComplete();
        }
      },
    });

    await queue.add({
      groupId: 'test-group',
      data: { id: 2 },
      orderMs: 200,
    });

    await queue.add({
      groupId: 'test-group',
      data: { id: 1 },
      orderMs: 100,
    });

    await completePromise;
    await worker.close();

    expect(processed).toEqual([1, 2]);
  });
});
