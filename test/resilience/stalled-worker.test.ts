import { describe, expect, test } from '../helpers/suite';

describe('任务卡顿恢复 (Stalled Job Recovery)', () => {
  test('应当支持卡顿任务检测配置 (should support stalled job detection configuration)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        return { processed: job.data };
      },
      stalledInterval: 100,
      maxStalledCount: 1,
      stalledGracePeriod: 0,
    });

    worker.on('stalled', (jobId, groupId) => {
      console.log(`Job ${jobId} from group ${groupId} was stalled`);
    });

    expect(worker).toBeDefined();
  });

  test('应当不干扰正常完成的任务 (should not interfere with normally completing jobs)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const completedJobs: any[] = [];
    const stalledEvents: any[] = [];

    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: `group-${i}`,
        data: { id: i },
      });
    }

    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { processed: job.data };
      },
      stalledInterval: 200,
      maxStalledCount: 1,
    });

    worker.on('completed', (job) => {
      completedJobs.push(job);
    });

    worker.on('stalled', (jobId, groupId) => {
      stalledEvents.push({ jobId, groupId });
    });

    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(completedJobs.length).toBe(5);
    expect(stalledEvents.length).toBe(0);

    const activeCount = await queue.getActiveCount();
    expect(activeCount).toBe(0);
  });

  test('应当暴露 queue.checkStalledJobs 方法用于手动检查 (should expose queue.checkStalledJobs method for manual checking)', async ({ createQueue }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const now = Date.now();
    const gracePeriod = 1000;
    const maxStalledCount = 1;

    const results = await queue.checkStalledJobs(
      now,
      gracePeriod,
      maxStalledCount,
    );

    expect(Array.isArray(results)).toBe(true);
  });
});

describe('Worker 事件循环阻塞 (Worker Event Loop Blocking)', () => {
  test('应当检测具有许多组和少数 worker 的阻塞 (should detect worker blocking with many groups and few workers)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 30000,
    });

    const workerCount = 8;
    const groupCount = 100;
    const workers: ReturnType<typeof createWorker>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = createWorker({
        queue: queue,
        handler: async (job) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        blockingTimeoutSec: 2,
      });

      workers.push(worker);
      worker.run();
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    const jobPromises = [];
    for (let i = 0; i < groupCount; i++) {
      jobPromises.push(
        queue.add({
          groupId: `test-group-${i}`,
          data: { id: i, data: `test-data-${i}` },
        }),
      );
    }

    await Promise.all(jobPromises);

    let totalJobsProcessed = 0;
    const monitorDuration = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < monitorDuration) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      let activeWorkers = 0;
      let currentTotal = 0;

      for (const worker of workers) {
        const metrics = worker.getWorkerMetrics();
        currentTotal += metrics.totalJobsProcessed;

        if (
          metrics.isProcessing ||
          metrics.timeSinceLastJob === null ||
          metrics.timeSinceLastJob < 5000
        ) {
          activeWorkers++;
        }

        if (metrics.blockingStats.consecutiveEmptyReserves > 5) {
          console.warn(
            `⚠️ Worker ${metrics.name} has ${metrics.blockingStats.consecutiveEmptyReserves} consecutive empty reserves`,
          );
        }
      }

      totalJobsProcessed = currentTotal;

      const queueStats = await queue.getJobCounts();
      if (queueStats.active === 0 && queueStats.waiting === 0) {
        break;
      }
    }

    expect(totalJobsProcessed).toBeGreaterThan(50);

    for (const worker of workers) {
      const metrics = worker.getWorkerMetrics();
      expect(metrics.blockingStats.consecutiveEmptyReserves).toBeLessThan(20);
    }
  }, 30000);

  test('应当优雅地处理 Redis 连接问题 (should handle Redis connection issues gracefully)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 30000,
    });

    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      blockingTimeoutSec: 1,
    });

    worker.run();

    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: `test-group-${i}`,
        data: { id: i },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const metrics = worker.getWorkerMetrics();

    expect(metrics.totalJobsProcessed).toBeGreaterThan(0);
  }, 15000);

  test('应当检测卡顿的 worker 并输出详细日志 (should detect stuck workers with comprehensive logging)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 30000,
    });

    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        if ((job.data as any).shouldFail) {
          throw new Error('Simulated job failure');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      blockingTimeoutSec: 1,
      maxAttempts: 1,
    });

    worker.run();

    for (let i = 0; i < 3; i++) {
      await queue.add({
        groupId: `fail-group-${i}`,
        data: { id: i, shouldFail: true },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const metrics = worker.getWorkerMetrics();
    expect(metrics.blockingStats.totalBlockingCalls).toBeGreaterThan(0);
  }, 15000);
});
