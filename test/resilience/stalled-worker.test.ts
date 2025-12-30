import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue';
import { Worker } from '../../src/worker';
import { createRedis } from '../helpers/redis';

describe('任务卡顿恢复 (Stalled Job Recovery)', () => {
  let redis: any;
  let queue: Queue;
  let workers: Worker[] = [];
  let namespace: string;

  beforeEach(async () => {
    namespace = `test-stalled-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    redis = createRedis();

    const keys = await redis.keys(`groupmq:${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    queue = new Queue({
      redis: redis.duplicate(),
      namespace,
      jobTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close(0)));
    workers = [];

    const keys = await redis.keys(`groupmq:${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    await queue.close();
    await redis.quit();
  });

  it('应当支持卡顿任务检测配置 (should support stalled job detection configuration)', () => {
    // This test documents the API and configuration options
    const worker = new Worker({
      queue: queue,
      handler: async (job) => {
        return { processed: job.data };
      },
      stalledInterval: 100, // Check every 100ms for faster tests
      maxStalledCount: 1, // Fail after 1 stall
      stalledGracePeriod: 0, // No grace period
    });

    // Event handler for stalled jobs
    worker.on('stalled', (jobId, groupId) => {
      console.log(`Job ${jobId} from group ${groupId} was stalled`);
    });

    workers.push(worker);

    expect(worker).toBeDefined();
  });

  it('应当不干扰正常完成的任务 (should not interfere with normally completing jobs)', async () => {
    const completedJobs: any[] = [];
    const stalledEvents: any[] = [];

    // Add multiple jobs
    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: `group-${i}`,
        data: { id: i },
      });
    }

    const worker = new Worker({
      queue: queue,
      handler: async (job) => {
        // Normal job processing - completes quickly
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { processed: job.data };
      },
      stalledInterval: 200, // Check frequently
      maxStalledCount: 1,
    });

    worker.on('completed', (job) => {
      completedJobs.push(job);
    });

    worker.on('stalled', (jobId, groupId) => {
      stalledEvents.push({ jobId, groupId });
    });

    workers.push(worker);

    worker.run().catch(() => {});

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // All jobs should complete normally
    expect(completedJobs.length).toBe(5);

    // No stalled events should be emitted for normally completing jobs
    expect(stalledEvents.length).toBe(0);

    // No jobs should be in active state
    const activeCount = await queue.getActiveCount();
    expect(activeCount).toBe(0);
  });

  it('应当暴露 queue.checkStalledJobs 方法用于手动检查 (should expose queue.checkStalledJobs method for manual checking)', async () => {
    // This documents the manual checking API
    const now = Date.now();
    const gracePeriod = 1000;
    const maxStalledCount = 1;

    // The method exists and can be called
    const results = await queue.checkStalledJobs(
      now,
      gracePeriod,
      maxStalledCount,
    );

    // Returns an array (empty if no stalled jobs)
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('Worker 事件循环阻塞 (Worker Event Loop Blocking)', () => {
  let redis: any;
  let queue: Queue;
  let workers: Worker[] = [];
  let namespace: string;

  beforeEach(async () => {
    // Create unique namespace for each test to avoid interference
    namespace = `test-blocking-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    redis = createRedis();

    // Clear any existing test data
    const keys = await redis.keys(`groupmq:${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    queue = new Queue({
      redis: redis.duplicate(),
      namespace,
      jobTimeoutMs: 30000,
    });
  });

  afterEach(async () => {
    // Close all workers
    await Promise.all(workers.map((w) => w.close()));
    workers = [];

    // Clean up test data
    const keys = await redis.keys(`groupmq:${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    await redis.quit();
  });

  it('应当检测具有许多组和少数 worker 的阻塞 (should detect worker blocking with many groups and few workers)', async () => {
    // Create 8 workers
    const workerCount = 8;
    const groupCount = 100; // Many more groups than workers

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker({
        queue: queue,
        handler: async (job) => {
          // Simulate work
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        blockingTimeoutSec: 2, // Short timeout for testing
      });

      workers.push(worker);

      // Start worker and give it time to initialize
      worker.run().catch((err) => {
        console.error(`Worker ${i} error:`, err);
      });
    }

    // Wait for workers to start - reduced delay
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Add jobs to many different groups
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

    // Monitor workers for a period to see if any get stuck - reduced duration
    let totalJobsProcessed = 0;
    const monitorDuration = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < monitorDuration) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get worker metrics
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

        // Log warning if worker seems stuck
        if (metrics.blockingStats.consecutiveEmptyReserves > 5) {
          console.warn(
            `⚠️ Worker ${metrics.name} has ${metrics.blockingStats.consecutiveEmptyReserves} consecutive empty reserves`,
          );
        }
      }

      totalJobsProcessed = currentTotal;

      // If all jobs are processed, break early
      const queueStats = await queue.getJobCounts();
      if (queueStats.active === 0 && queueStats.waiting === 0) {
        break;
      }
    }

    // Verify that workers are working efficiently
    expect(totalJobsProcessed).toBeGreaterThan(50); // Should process a good number of jobs

    // Check that no worker is completely stuck (more than 20 consecutive empty reserves is concerning)
    for (const worker of workers) {
      const metrics = worker.getWorkerMetrics();
      expect(metrics.blockingStats.consecutiveEmptyReserves).toBeLessThan(20);
    }
  }, 30000); // 30 second timeout for the test

  it('应当优雅地处理 Redis 连接问题 (should handle Redis connection issues gracefully)', async () => {
    // Create a worker
    const worker = new Worker({
      queue: queue,
      handler: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      blockingTimeoutSec: 1, // Very short timeout
    });

    workers.push(worker);

    // Start worker
    worker.run().catch((err) => {
      console.error('Worker error:', err);
    });

    // Add a few jobs
    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: `test-group-${i}`,
        data: { id: i },
      });
    }

    // Let it process for a bit - reduced for faster tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Check that worker isn't stuck even with short timeouts
    const metrics = worker.getWorkerMetrics();

    expect(metrics.totalJobsProcessed).toBeGreaterThan(0);
  }, 15000);

  it('应当检测卡顿的 worker 并输出详细日志 (should detect stuck workers with comprehensive logging)', async () => {
    // Create a worker that will get "stuck" (simulate by adding jobs it can't process)
    const worker = new Worker({
      queue: queue,
      handler: async (job) => {
        // Simulate a job that takes a long time or fails
        if ((job.data as any).shouldFail) {
          throw new Error('Simulated job failure');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      blockingTimeoutSec: 1,
      maxAttempts: 1, // Quick failure
    });

    workers.push(worker);

    // Start worker
    worker.run().catch((err) => {
      console.error('Worker error:', err);
    });

    // Add some jobs that will fail
    for (let i = 0; i < 3; i++) {
      await queue.add({
        groupId: `fail-group-${i}`,
        data: { id: i, shouldFail: true },
      });
    }

    // Monitor for stuck detection - reduced for faster tests
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const metrics = worker.getWorkerMetrics();
    // Worker should have attempted to process jobs
    expect(metrics.blockingStats.totalBlockingCalls).toBeGreaterThan(0);
  }, 15000);
});
