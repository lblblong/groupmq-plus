import { describe, expect, test, waitUntil } from '../helpers/suite';

describe('Concurrency and Race Condition Tests', () => {
  test('should handle multiple workers distributing across different groups with atomic completion', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    // Add 10 jobs to one group (should be processed by one worker)
    for (let i = 0; i < 10; i++) {
      await q.add({
        groupId: 'group-heavy',
        data: { id: i, group: 'heavy' },
      });
    }

    // Add 1 job to another group (should be processed by the other worker)
    await q.add({
      groupId: 'group-light',
      data: { id: 10, group: 'light' },
    });

    const processed: any[] = [];
    const processedBy: { [key: number]: any[] } = {};

    // Create 2 workers
    for (let workerId = 0; workerId < 2; workerId++) {
      const worker = createWorker({
        queue: q,
        blockingTimeoutSec: 1,
        concurrency: 1,
        handler: async (job) => {
          const jobData = job.data as any;
          processed.push(jobData);
          if (!processedBy[workerId]) processedBy[workerId] = [];
          processedBy[workerId].push(jobData);
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });
      worker.run();
    }

    await q.waitForEmpty();

    expect(processed.length).toBe(11);
    expect(new Set(processed.map((j) => j.id)).size).toBe(11);

    const heavyGroupJobs = processed.filter((j) => j.group === 'heavy');
    const lightGroupJobs = processed.filter((j) => j.group === 'light');

    expect(heavyGroupJobs.length).toBe(10);
    expect(lightGroupJobs.length).toBe(1);

    const heavyWorkerIds = new Set(
      heavyGroupJobs.map((j) => {
        for (const [workerId, jobs] of Object.entries(processedBy)) {
          if (jobs.some((job) => job.id === j.id)) return parseInt(workerId);
        }
        return -1;
      }),
    );

    const lightWorkerIds = new Set(
      lightGroupJobs.map((j) => {
        for (const [workerId, jobs] of Object.entries(processedBy)) {
          if (jobs.some((job) => job.id === j.id)) return parseInt(workerId);
        }
        return -1;
      }),
    );

    expect(heavyWorkerIds.size).toBe(1);
    expect(lightWorkerIds.size).toBe(1);
    expect(heavyWorkerIds).not.toEqual(lightWorkerIds);

    const heavyWorkerId = Array.from(heavyWorkerIds)[0];
    const heavyWorkerJobs = processedBy[heavyWorkerId] || [];
    const heavyJobsByWorker = heavyWorkerJobs.filter(
      (j) => j.group === 'heavy',
    );
    expect(heavyJobsByWorker.length).toBe(10);
  });

  test('concurrency=1 时同组原子链式预留应连续处理所有任务', async ({
    createQueue,
    createWorker,
  }) => {
    const queue = createQueue();
    const groupId = 'chain-group';
    const jobCount = 8;

    for (let i = 0; i < jobCount; i++) {
      await queue.add({
        groupId,
        data: { seq: i },
        groupConfig: { concurrency: 1 },
      });
    }

    const processed: number[] = [];
    const worker = createWorker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push((job.data as { seq: number }).seq);
      },
    });
    worker.run();

    await queue.waitForEmpty();

    expect(processed).toEqual(Array.from({ length: jobCount }, (_, i) => i));
  });

  test('should handle concurrent add and dequeue operations', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const processed: number[] = [];
    const enqueued: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    worker.run();

    const producers = [];
    for (let producerId = 0; producerId < 3; producerId++) {
      const producer = async () => {
        for (let i = 0; i < 10; i++) {
          const jobId = producerId * 10 + i;
          await q.add({
            groupId: `concurrent-group-${producerId}`,
            data: { id: jobId },
            orderMs: jobId,
          });
          enqueued.push(jobId);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      };
      producers.push(producer());
    }

    await Promise.all(producers);
    await q.waitForEmpty();

    expect(processed.length).toBe(30);
    expect(enqueued.length).toBe(30);

    const groupOrders: { [key: string]: number[] } = {};
    processed.forEach((id) => {
      const groupId = Math.floor(id / 10);
      if (!groupOrders[groupId]) groupOrders[groupId] = [];
      groupOrders[groupId].push(id);
    });

    Object.entries(groupOrders).forEach(([groupId, order]) => {
      const expectedOrder = [...Array(10).keys()].map(
        (i) => Number.parseInt(groupId, 10) * 10 + i,
      );
      expect(order).toEqual(expectedOrder);
    });
  });

  test('should handle race conditions during job completion', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    for (let i = 0; i < 10; i++) {
      await q.add({
        groupId: 'completion-group',
        data: { id: i },
        orderMs: i,
      });
    }

    const completed: number[] = [];
    const completionAttempts = new Map<number, number>();

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        const id = (job.data as any).id;
        completionAttempts.set(id, (completionAttempts.get(id) || 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        completed.push(id);
      },
    });

    worker.run();
    await q.waitForEmpty();

    expect(completed.length).toBe(10);
    expect(new Set(completed).size).toBe(10);

    completionAttempts.forEach((attempts, _jobId) => {
      expect(attempts).toBe(1);
    });
  });

  test('should handle worker stopping during job processing', async ({ createQueue, createWorker }) => {
    const q = createQueue({
      jobTimeoutMs: 500,
    });

    for (let i = 0; i < 5; i++) {
      await q.add({
        groupId: 'stopping-group',
        data: { id: i },
        orderMs: i,
      });
    }

    const processed: number[] = [];
    let _processingCount = 0;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        _processingCount++;
        if ((job.data as any).id === 1) {
          setTimeout(() => worker.close(), 100);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        processed.push((job.data as any).id);
      },
    });

    worker.run();

    // 使用状态轮询等待 worker 关闭
    await waitUntil(() => worker.isClosed, 2000);

    const worker2 = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
    });

    worker2.run();

    // 使用 waitForEmpty 等待队列清空
    await q.waitForEmpty({ timeoutMs: 3000 });

    expect(processed.length).toBeGreaterThanOrEqual(4);
  });

  test('should handle high-frequency add/dequeue cycles', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const processed: number[] = [];
    const timestamps: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
        timestamps.push(Date.now());
      },
    });

    worker.run();

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await q.add({
        groupId: `freq-group-${i % 5}`,
        data: { id: i },
        orderMs: i,
      });

      if (i % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const enqueueTime = Date.now() - start;

    // 使用 waitForEmpty 等待队列清空
    await q.waitForEmpty({ timeoutMs: 5000 });

    expect(processed.length).toBe(100);

    const groupedResults: { [key: number]: number[] } = {};
    processed.forEach((id) => {
      const groupId = id % 5;
      if (!groupedResults[groupId]) groupedResults[groupId] = [];
      groupedResults[groupId].push(id);
    });

    Object.entries(groupedResults).forEach(([groupId, jobs]) => {
      const expectedJobs = [...Array(20).keys()].map(
        (i) => i * 5 + Number.parseInt(groupId, 10),
      );
      expect(jobs.sort((a, b) => a - b)).toEqual(expectedJobs);
    });
  });

  test('should handle memory pressure with large datas', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const largeData = 'x'.repeat(10000);

    for (let i = 0; i < 20; i++) {
      await q.add({
        groupId: `memory-group-${i % 3}`,
        data: { id: i, data: largeData },
        orderMs: i,
      });
    }

    const processed: number[] = [];
    const memoryUsage: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
        memoryUsage.push(process.memoryUsage().heapUsed);
        expect((job.data as any).data.length).toBe(10000);
        expect((job.data as any).data).toBe(largeData);
      },
    });

    worker.run();

    // 使用 waitForEmpty 等待队列清空
    await q.waitForEmpty({ timeoutMs: 5000 });

    expect(processed.length).toBe(20);

    const memoryGrowth = memoryUsage[memoryUsage.length - 1] - memoryUsage[0];
    expect(memoryGrowth).toBeLessThan(200 * 1024 * 1024);
  });

  test('should handle deadlock scenarios with multiple groups', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    await q.add({
      groupId: 'group-A',
      data: { id: 'A1', waitFor: null },
      orderMs: 1,
    });
    await q.add({
      groupId: 'group-B',
      data: { id: 'B1', waitFor: null },
      orderMs: 2,
    });
    await q.add({
      groupId: 'group-A',
      data: { id: 'A2', waitFor: 'B1' },
      orderMs: 3,
    });
    await q.add({
      groupId: 'group-B',
      data: { id: 'B2', waitFor: 'A1' },
      orderMs: 4,
    });

    const processed: string[] = [];
    const failed: string[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      maxAttempts: 3,
      backoff: () => 100,
      handler: async (job) => {
        const { id, waitFor } = job.data as any;
        if (waitFor && !processed.includes(waitFor)) {
          throw new Error(`Job ${id} waiting for ${waitFor}`);
        }
        processed.push(id);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      onError: (_err, job) => {
        if (job) {
          failed.push((job.data as any).id);
        }
      },
    });

    worker.run();

    // 使用状态轮询等待所有任务处理完成
    await waitUntil(() => processed.length >= 4, 5000);

    expect(processed).toContain('A1');
    expect(processed).toContain('B1');
    expect(processed).toContain('A2');
    expect(processed).toContain('B2');
  });
});

describe('Group Concurrency', () => {
  test('should limit concurrency for specific group', async ({ createQueue, createWorker }) => {
    const queue = createQueue();
    const groupId = 'limited-group';

    await queue.groups.setConcurrency(groupId, 2);

    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId,
        data: { index: i },
        jobId: `job-${i}`
      });
    }

    const activeJobs: string[] = [];
    const worker = createWorker({
      queue,
      concurrency: 5,
      handler: async (job) => {
        activeJobs.push(job.id);
        await new Promise(resolve => setTimeout(resolve, 200));
        activeJobs.splice(activeJobs.indexOf(job.id), 1);
      }
    });

    let maxConcurrent = 0;
    const interval = setInterval(() => {
      maxConcurrent = Math.max(maxConcurrent, activeJobs.length);
    }, 10);

    worker.run();

    // 使用 waitForEmpty 等待队列清空
    await queue.waitForEmpty({ timeoutMs: 5000 });
    clearInterval(interval);

    console.log('Max concurrent jobs observed:', maxConcurrent);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
