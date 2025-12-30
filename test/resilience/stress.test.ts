import { describe, expect, test } from '../helpers/suite';

describe('压力与性能下降测试 (Stress and Performance Degradation Tests)', () => {
  test('应当处理持续高吞吐量 (should handle sustained high throughput over time)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const processed: number[] = [];
    const throughputSamples: number[] = [];
    let lastSampleTime = Date.now();
    let lastSampleCount = 0;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 5,
      handler: async (job) => {
        processed.push(job.data.id);

        if (processed.length % 1000 === 0) {
          const now = Date.now();
          const timeDiff = now - lastSampleTime;
          const countDiff = processed.length - lastSampleCount;
          const throughput = (countDiff / timeDiff) * 1000;

          throughputSamples.push(throughput);
          lastSampleTime = now;
          lastSampleCount = processed.length;
        }
      },
    });

    worker.run();

    const totalJobs = 2500;
    const batchSize = 100;

    for (let batch = 0; batch < totalJobs / batchSize; batch++) {
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        const jobId = batch * batchSize + i;
        promises.push(
          q.add({
            groupId: `sustained-group-${jobId % 10}`,
            data: { id: jobId },
            orderMs: jobId,
          }),
        );
      }
      await Promise.all(promises);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await q.waitForEmpty(15000);

    const expectedMin = Math.floor(totalJobs * 0.80);
    expect(processed.length).toBeGreaterThanOrEqual(expectedMin);

    if (throughputSamples.length > 2) {
      const firstSample = throughputSamples[0];
      const lastSample = throughputSamples[throughputSamples.length - 1];
      const degradation = (firstSample - lastSample) / firstSample;
      expect(degradation).toBeLessThan(0.5);
    }
  }, 30000);


  test('应当处理许多待处理任务的内存压力 (should handle memory pressure with many pending jobs)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const totalJobs = 1500;
    const startTime = Date.now();

    for (let i = 0; i < totalJobs; i++) {
      await q.add({
        groupId: `pending-group-${i % 50}`,
        data: {
          id: i,
          timestamp: Date.now(),
          data: 'data-data-'.repeat(10),
        },
        orderMs: i,
      });
    }

    const enqueueTime = Date.now() - startTime;

    const processed: number[] = [];
    const processingStartTime = Date.now();

    const workers: ReturnType<typeof createWorker>[] = [];
    for (let i = 0; i < 5; i++) {
      const worker = createWorker({
        queue: q,
        blockingTimeoutSec: 5,
        handler: async (job) => {
          processed.push(job.data.id);
        },
      });
      workers.push(worker);
      worker.run();
    }

    while (
      processed.length < totalJobs &&
      Date.now() - processingStartTime < 15000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(processed.length).toBe(totalJobs);

    const memoryUsage = process.memoryUsage();
    expect(memoryUsage.heapUsed).toBeLessThan(500 * 1024 * 1024);
  }, 60000);

  test('应当处理 worker 变动（启动和停止）(should handle worker churn (workers starting and stopping))', async ({ createQueue, createWorker }) => {
    const q = createQueue({
      jobTimeoutMs: 5000,
    });

    const totalJobs = 800;
    let enqueuedCount = 0;

    const enqueueInterval = setInterval(async () => {
      if (enqueuedCount < totalJobs) {
        await q.add({
          groupId: `churn-group-${enqueuedCount % 5}`,
          data: { id: enqueuedCount },
          orderMs: enqueuedCount,
        });
        enqueuedCount++;
      } else {
        clearInterval(enqueueInterval);
      }
    }, 5);

    const processed: number[] = [];

    const workerLifecycle = async (_workerId: number) => {
      while (processed.length < totalJobs) {
        const worker = createWorker({
          queue: q,
          blockingTimeoutSec: 1,
          handler: async (job) => {
            processed.push(job.data.id);
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
        });

        worker.run();

        const lifetime = 500 + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, lifetime));

        await worker.close(2000);

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const workerPromises = [];
    for (let i = 0; i < 3; i++) {
      workerPromises.push(workerLifecycle(i));
    }

    await Promise.all(workerPromises);

    expect(processed.length).toBeGreaterThan(totalJobs * 0.95);
    const duplicateRate =
      (processed.length - new Set(processed).size) / processed.length;
    expect(duplicateRate).toBeLessThan(0.45);
  }, 30000);


  test('应当处理突发流量模式 (should handle burst traffic patterns)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const processed: number[] = [];
    const processingTimes: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 2,
      handler: async (job) => {
        const startTime = Date.now();
        processed.push(job.data.id);

        const processingTime = 5 + Math.random() * 15;
        await new Promise((resolve) => setTimeout(resolve, processingTime));

        processingTimes.push(Date.now() - startTime);
      },
    });

    worker.run();

    let jobCounter = 0;

    for (let burst = 0; burst < 5; burst++) {
      const burstSize = 100 + Math.random() * 50;
      const burstPromises = [];

      for (let i = 0; i < burstSize; i++) {
        burstPromises.push(
          q.add({
            groupId: `burst-group-${jobCounter % 10}`,
            data: { id: jobCounter, burst: burst },
            orderMs: jobCounter,
          }),
        );
        jobCounter++;
      }

      await Promise.all(burstPromises);

      await q.waitForEmpty();

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await q.waitForEmpty(10000);

    expect(processed.length).toBeGreaterThan(jobCounter * 0.8);

    if (processingTimes.length > 0) {
      const avgProcessingTime =
        processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      expect(avgProcessingTime).toBeLessThan(50);
    }
  }, 60000);

  test('应当优雅地处理渐进式资源耗尽 (should handle gradual resource exhaustion gracefully)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const processed: number[] = [];
    const errors: string[] = [];
    let _memoryLeakSize = 0;
    const memoryLeak: any[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data.id);

        const leakData = new Array(1000).fill('memory-leak-data');
        memoryLeak.push(leakData);
        _memoryLeakSize += leakData.length;

        const iterations = 1000 + processed.length * 10;
        let _sum = 0;
        for (let i = 0; i < iterations; i++) {
          _sum += Math.random();
        }

        if (processed.length % 100 === 0) {
          memoryLeak.splice(0, Math.floor(memoryLeak.length * 0.1));
        }
      },
      onError: (err) => {
        errors.push((err as Error).message);
      },
    });

    worker.run();

    let jobId = 0;
    for (let round = 0; round < 5; round++) {
      const jobsThisRound = 50 + round * 10;

      for (let i = 0; i < jobsThisRound; i++) {
        await q.add({
          groupId: `exhaustion-group-${jobId % 5}`,
          data: { id: jobId, round: round },
          orderMs: jobId,
        });
        jobId++;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await q.waitForEmpty(10000);

    expect(processed.length).toBeGreaterThan(jobId * 0.8);

    expect(errors.length).toBeLessThan(jobId * 0.1);
  }, 30000);


  test('应当使用大量组维持性能 (should maintain performance with large number of groups)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const numGroups = 200;
    const jobsPerGroup = 10;
    const totalJobs = numGroups * jobsPerGroup;

    const startTime = Date.now();
    for (let groupId = 0; groupId < numGroups; groupId++) {
      const promises = [];
      for (let jobId = 0; jobId < jobsPerGroup; jobId++) {
        promises.push(
          q.add({
            groupId: `group-${groupId}`,
            data: { groupId, jobId },
            orderMs: groupId * jobsPerGroup + jobId,
          }),
        );
      }
      await Promise.all(promises);
    }

    const processed: { groupId: number; jobId: number }[] = [];
    const processingStartTime = Date.now();

    const workers: ReturnType<typeof createWorker>[] = [];
    for (let i = 0; i < 5; i++) {
      const worker = createWorker({
        queue: q,
        blockingTimeoutSec: 5,
        handler: async (job) => {
          processed.push(job.data);
        },
      });
      workers.push(worker);
      worker.run();
    }

    await q.waitForEmpty();

    expect(processed.length).toBe(totalJobs);

    const groupResults: { [key: number]: number[] } = {};
    processed.forEach(({ groupId, jobId }) => {
      if (!groupResults[groupId]) groupResults[groupId] = [];
      groupResults[groupId].push(jobId);
    });

    const sampleGroups = [0, 50, 100, 199];
    sampleGroups.forEach((groupId) => {
      if (groupResults[groupId]) {
        const expectedOrder = [...Array(jobsPerGroup).keys()];
        expect(groupResults[groupId]).toEqual(expectedOrder);
      }
    });

    const processingTime = Date.now() - processingStartTime;
    const throughput = totalJobs / (processingTime / 1000);

    expect(throughput).toBeGreaterThan(100);
  }, 120000);
});
