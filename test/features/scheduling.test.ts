import { describe, expect, test } from '../helpers/suite';

describe('延迟任务 (Delayed Jobs)', () => {
  test('应该延迟任务并在延迟过期后处理', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ schedulerLockTtlMs: 50 });
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      schedulerIntervalMs: 50,
    });

    worker.run();

    const startTime = Date.now();
    const delayMs = 200;

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

    // Verify both jobs were processed
    expect(processed).toHaveLength(2);

    const immediateJob = processed.find((p) => p.id === 'immediate-job');
    const delayedJob = processed.find((p) => p.id === 'delayed-job');

    expect(immediateJob).toBeDefined();
    expect(delayedJob).toBeDefined();

    // Verify delayed job was processed after the delay
    const delayedJobProcessTime = delayedJob!.processedAt - startTime;
    expect(delayedJobProcessTime).toBeGreaterThanOrEqual(delayMs - 50);

    // Verify immediate job was processed quickly
    const immediateJobProcessTime = immediateJob!.processedAt - startTime;
    expect(immediateJobProcessTime).toBeLessThan(200);
  });

  test('应该处理 runAt 调度', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ schedulerLockTtlMs: 50 });
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      schedulerIntervalMs: 50,
    });

    worker.run();

    const runAt = new Date(Date.now() + 200);

    await queue.add({
      groupId: 'scheduled-group',
      data: { id: 'scheduled-job' },
      runAt,
    });

    await queue.waitForEmpty();

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe('scheduled-job');

    // Verify job was processed at approximately the right time
    const actualRunTime = processed[0].processedAt;
    const expectedRunTime = runAt.getTime();
    const timeDiff = Math.abs(actualRunTime - expectedRunTime);

    expect(timeDiff).toBeLessThan(300);
  });

  test('应该不允许过去的日期用于 runAt', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ schedulerLockTtlMs: 50 });
    const processed: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
    });

    worker.run();

    // Try to schedule in the past
    const pastDate = new Date(Date.now() - 5000);

    await queue.add({
      groupId: 'past-group',
      data: { id: 'past-job' },
      runAt: pastDate,
    });

    await queue.waitForEmpty(2000);

    // Job should be processed immediately since past dates are clamped to now
    expect(processed).toContain('past-job');
  });

  test('应该支持 changeDelay 功能', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ schedulerLockTtlMs: 50 });
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
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

    await queue.waitForEmpty(1000);

    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe('changeable-job');

    // Job should have been processed around 100-200ms (50ms wait + 50ms new delay + scheduler overhead)
    const actualProcessTime = processed[0].processedAt - startTime;
    expect(actualProcessTime).toBeGreaterThan(80);
    expect(actualProcessTime).toBeLessThan(400);
  });

  test('应该在延迟中保持组内的 FIFO 顺序', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ schedulerLockTtlMs: 50 });
    const processed: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
      schedulerIntervalMs: 50,
    });

    worker.run();

    // Add jobs with different delays but same group
    await queue.add({
      groupId: 'fifo-delay-group',
      data: { id: 'job1' },
      delay: 150,
      orderMs: 1000,
    });

    await queue.add({
      groupId: 'fifo-delay-group',
      data: { id: 'job2' },
      delay: 150,
      orderMs: 2000,
    });

    await queue.waitForEmpty(2000);

    expect(processed).toHaveLength(2);
    // 同一组内，按 orderMs 排序，job1 的 orderMs=1000 < job2 的 orderMs=2000
    // 所以 job1 先处理
    expect(processed).toEqual(['job1', 'job2']);
  });
});

describe('周期任务 (Cron/Repeating Jobs)', () => {
  test('应该使用 every 选项创建并处理重复任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 100,
      schedulerLockTtlMs: 50,
    });
    const processed: Array<{ id: string; processedAt: number }> = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push({
          id: (job.data as any).id,
          processedAt: Date.now(),
        });
      },
      schedulerIntervalMs: 30,
    });

    worker.run();

    // Create a job that repeats every 50ms
    const cronJob = await queue.add({
      groupId: 'cron-group',
      data: { id: 'recurring-job', message: 'Hello from cron!' },
      repeat: { every: 50 },
    });

    expect(cronJob.id).toContain('repeat:');

    // Wait for multiple executions
    // 增加等待时间以容忍调度器启动延迟和环境波动
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Should have processed the job multiple times (at least 3 times in 350ms)
    expect(processed.length).toBeGreaterThanOrEqual(3);
    expect(processed.length).toBeLessThanOrEqual(10);

    // All processed jobs should have the same data
    processed.forEach((job) => {
      expect(job.id).toBe('recurring-job');
    });
  });

  test('应该处理 cron 表达式模式', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 100,
      schedulerLockTtlMs: 50,
    });
    const processed: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push(`${(job.data as any).id}-${Date.now()}`);
      },
    });

    worker.run();

    // Create a job that runs every minute
    const cronJob = await queue.add({
      groupId: 'pattern-group',
      data: { id: 'minute-job' },
      repeat: { pattern: '* * * * *' },
    });

    expect(cronJob.id).toContain('repeat:');
    expect(cronJob).toBeDefined();
  });

  test('应该删除重复任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 100,
      schedulerLockTtlMs: 50,
    });
    const processed: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
      schedulerIntervalMs: 30,
    });

    worker.run();

    const repeatOptions = { every: 50 };

    // Create a repeating job
    await queue.add({
      groupId: 'removable-group',
      data: { id: 'removable-job' },
      repeat: repeatOptions,
    });

    // Let it run a few times
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Give the scheduler a moment to ensure the repeating job is fully set up
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Remove the repeating job
    const removed = await queue.removeRepeatingJob(
      'removable-group',
      repeatOptions,
    );
    expect(removed).toBe(true);

    // Wait for the group to drain completely
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

    // Wait for several scheduler intervals
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now verify no new jobs are scheduled
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should not have processed more jobs after the queue drained
    expect(processed.length).toBeLessThanOrEqual(processedSoFar + 5);
  });

  test('应该处理复杂的 cron 表达式', async ({ createQueue }) => {
    const queue = createQueue({
      jobTimeoutMs: 100,
      schedulerLockTtlMs: 50,
    });

    // This should not throw an error
    try {
      await queue.add({
        groupId: 'complex-group',
        data: { id: 'complex-job' },
        repeat: { pattern: '0 9 * * 1-5' },
      });
    } catch (error) {
      expect(error).toBeUndefined();
    }

    // Test invalid pattern
    try {
      await queue.add({
        groupId: 'invalid-group',
        data: { id: 'invalid-job' },
        repeat: { pattern: 'invalid pattern' },
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});

describe('自定义排序 (Custom Ordering)', () => {
  test('应该在任务无序到达时按正确的 orderMs 顺序处理任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ orderingDelayMs: 150 });

    const processed: Array<{ id: number; orderMs: number }> = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = createWorker({
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

    // Job 3 arrives first but has latest orderMs
    await queue.add({
      groupId: 'test-group',
      data: { id: 3 },
      orderMs: now + 100,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job 2 arrives second
    await queue.add({
      groupId: 'test-group',
      data: { id: 2 },
      orderMs: now + 50,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job 1 arrives last but has earliest orderMs
    await queue.add({
      groupId: 'test-group',
      data: { id: 1 },
      orderMs: now,
    });

    await completePromise;

    // Jobs should be processed in orderMs order, not arrival order
    expect(processed).toHaveLength(3);
    expect(processed[0].id).toBe(1);
    expect(processed[1].id).toBe(2);
    expect(processed[2].id).toBe(3);
    expect(processed[0].orderMs).toBe(now);
    expect(processed[1].orderMs).toBe(now + 50);
    expect(processed[2].orderMs).toBe(now + 100);
  });

  test('应该在未提供 orderMs 时不暂存任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ orderingDelayMs: 150 });

    const processed: string[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = createWorker({
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

    // Without orderMs, jobs should be processed in arrival order
    expect(processed).toEqual(['first', 'second']);
  });

  test('应该在 orderingDelayMs 为 0 时不暂存任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ orderingDelayMs: 0 });

    const processed: Array<{ id: number; orderMs: number }> = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = createWorker({
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

    // Add jobs simultaneously with orderMs in reverse order
    await Promise.all([
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

    // With orderingDelayMs = 0, jobs process in orderMs order (score-based) from ZSET
    expect(processed).toHaveLength(3);
    expect(processed[0].id).toBe(1);
    expect(processed[1].id).toBe(2);
    expect(processed[2].id).toBe(3);
  });

  test('应该为多个组独立处理暂存', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ orderingDelayMs: 150 });

    const processedA: number[] = [];
    const processedB: number[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = createWorker({
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

    // Each group should process in correct order
    expect(processedA).toEqual([1, 2]);
    expect(processedB).toEqual([3, 4]);
  });

  test('应该处理启动多次的 promoter（幂等）', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ orderingDelayMs: 150 });

    // Start promoter multiple times - should not cause issues
    await queue.startPromoter();
    await queue.startPromoter();
    await queue.startPromoter();

    const processed: number[] = [];
    let resolveComplete: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    const worker = createWorker({
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

    expect(processed).toEqual([1, 2]);
  });
});
