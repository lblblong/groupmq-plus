import { describe, expect, test, waitUntil } from '../helpers/suite';
import { getWorkersStatus } from '../../src';

describe('优雅关闭测试 (Graceful Shutdown Tests)', () => {
  test('应当正确追踪活跃任务计数 (should track active job count correctly)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    expect(await queue.getActiveCount()).toBe(0);

    await queue.add({ groupId: 'test-group', data: { id: 1 } });
    await queue.add({ groupId: 'test-group', data: { id: 2 } });

    expect(await queue.getActiveCount()).toBe(0);

    let job1Started = false;
    let job1CanComplete = false;
    const processed: number[] = [];

    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        if ((job.data as any).id === 1) {
          job1Started = true;
          while (!job1CanComplete) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        processed.push((job.data as any).id);
      },
    });

    worker.run();

    while (!job1Started) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await queue.getActiveCount()).toBe(1);

    job1CanComplete = true;

    await queue.waitForEmpty();

    expect(await queue.getActiveCount()).toBe(0);
  });

  test('应当等待队列变空 (should wait for queue to empty)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    expect(await queue.waitForEmpty()).toBe(true);

    await queue.add({ groupId: 'empty-group', data: { id: 1 } });
    await queue.add({ groupId: 'empty-group', data: { id: 2 } });

    let processedCount = 0;
    const processedIds: number[] = [];
    const worker = createWorker({
      queue: queue,
      handler: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        processedCount++;
        processedIds.push((job.data as any).id);
      },
    });

    worker.run();

    let waitAttempts = 0;
    while ((await queue.getActiveCount()) === 0 && waitAttempts < 20) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      waitAttempts++;
    }

    expect(await queue.getActiveCount()).toBeGreaterThan(0);

    const startTime = Date.now();
    const isEmpty = await queue.waitForEmpty();
    const elapsed = Date.now() - startTime;

    expect(isEmpty).toBe(true);
    expect(processedCount).toBe(2);
    expect(processedIds.sort()).toEqual([1, 2]);
    expect(elapsed).toBeGreaterThan(80);
  });

  test('应当追踪 worker 中的当前任务 (should track current job in worker)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    let jobStarted = false;
    let jobCanComplete = false;

    const worker = createWorker({
      queue: queue,
      handler: async (_job) => {
        jobStarted = true;
        while (!jobCanComplete) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
    });

    expect(worker.isProcessing()).toBe(false);
    expect(worker.getCurrentJob()).toBe(null);

    worker.run();

    await queue.add({ groupId: 'current-group', data: { id: 1 } });

    while (!jobStarted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(worker.isProcessing()).toBe(true);

    const currentJob = worker.getCurrentJob();
    expect(currentJob).not.toBe(null);
    expect((currentJob!.job as any).data.id).toBe(1);
    expect(currentJob!.processingTimeMs).toBeGreaterThan(0);

    jobCanComplete = true;

    while (worker.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(worker.getCurrentJob()).toBe(null);
  });

  test('应当优雅地停止 worker (should stop worker gracefully)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    let jobStarted = false;
    let jobCompleted = false;

    const worker = createWorker({
      queue: queue,
      handler: async (_job) => {
        jobStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        jobCompleted = true;
      },
    });

    worker.run();

    await queue.add({ groupId: 'graceful-group', data: { id: 1 } });

    while (!jobStarted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(worker.isProcessing()).toBe(true);

    const stopPromise = worker.close(2000);

    await stopPromise;

    expect(jobCompleted).toBe(true);
    expect(worker.isProcessing()).toBe(false);
  });

  test('如果任务耗时过长，应当超时优雅停止 (should timeout graceful stop if job takes too long)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    let jobStarted = false;
    let shouldStop = false;
    let sawGracefulTimeout = false;

    const worker = createWorker({
      queue: queue,
      handler: async (_job) => {
        jobStarted = true;
        while (!shouldStop) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
    });

    worker.on('graceful-timeout', (_info) => {
      sawGracefulTimeout = true;
    });

    worker.run();

    await queue.add({ groupId: 'timeout-group', data: { id: 1 } });

    while (!jobStarted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(worker.isProcessing()).toBe(true);

    const startTime = Date.now();
    await worker.close(200);
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeGreaterThan(190);
    expect(elapsed).toBeLessThan(800);
    expect(sawGracefulTimeout).toBe(true);

    shouldStop = true;
  });

  test('应当正确获取 worker 状态 (should get workers status correctly)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    let job1Started = false;
    let job1CanComplete = false;

    const workers = [
      createWorker({
        queue: queue,
        handler: async (job) => {
          if (job.data.id === 1) {
            job1Started = true;
            while (!job1CanComplete) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      }),
      createWorker({
        queue: queue,
        handler: async (job) => {
          if (job.data.id === 1) {
            job1Started = true;
            while (!job1CanComplete) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      }),
    ];

    workers.forEach((worker) => {
      worker.run();
    });

    let status = getWorkersStatus(workers);
    expect(status.total).toBe(2);
    expect(status.processing).toBe(0);
    expect(status.idle).toBe(2);

    await queue.add({ groupId: 'status-group', data: { id: 1 } });

    let startAttempts = 0;
    while (!job1Started && startAttempts < 200) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      startAttempts++;
    }

    expect(job1Started).toBe(true);

    status = getWorkersStatus(workers);
    expect(status.total).toBe(2);
    expect(status.processing).toBe(1);
    expect(status.idle).toBe(1);

    const processingWorker = status.workers.find((w) => w.isProcessing);
    expect(processingWorker).toBeDefined();
    expect(processingWorker!.currentJob?.jobId).toBeDefined();

    job1CanComplete = true;

    let attempts = 0;
    while (workers.some((w) => w.isProcessing()) && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
    }

    expect(attempts).toBeLessThan(100);

    status = getWorkersStatus(workers);
    expect(status.processing).toBe(0);
    expect(status.idle).toBe(2);
  });

  test('应当在停止前完成长时间运行的任务 (should finish long-running job before stopping worker (graceful shutdown))', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.add({
      groupId: 'long-group',
      data: { taskType: 'long-running', duration: 300 },
    });

    let jobStartTime: number | null = null;
    let jobEndTime: number | null = null;
    let workerStoppedTime: number | null = null;
    let jobCompleted = false;

    const worker = createWorker({
      queue: queue,
      name: 'graceful-shutdown-worker',
      blockingTimeoutSec: 0.1,
      handler: async (job) => {
        jobStartTime = Date.now();

        if (job.data.taskType === 'long-running') {
          await new Promise((resolve) =>
            setTimeout(resolve, job.data.duration),
          );
        }

        jobEndTime = Date.now();
        jobCompleted = true;
      },
    });

    const workerPromise = worker.run();

    // 使用状态轮询等待任务开始
    await waitUntil(() => jobStartTime !== null, 2000);
    expect(jobStartTime).not.toBeNull();
    expect(jobCompleted).toBe(false);

    const stopPromise = worker.close();

    await stopPromise;
    await workerPromise;
    workerStoppedTime = Date.now();

    expect(jobCompleted).toBe(true);
    expect(jobEndTime).not.toBeNull();
    expect(jobStartTime).not.toBeNull();
    expect(workerStoppedTime).not.toBeNull();

    const jobDuration = jobEndTime! - jobStartTime!;
    expect(jobDuration).toBeGreaterThanOrEqual(280);
    expect(jobDuration).toBeLessThan(600);

    expect(jobEndTime!).toBeLessThanOrEqual(workerStoppedTime! + 100);
  }, 8000);

  test('关闭后不应该选择新任务 (should not pick up new jobs after shutdown is initiated)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.add({
      groupId: 'test-group',
      data: { taskType: 'first', id: 1 },
    });

    await queue.add({
      groupId: 'test-group',
      data: { taskType: 'second', id: 2 },
    });

    const processedJobs: any[] = [];
    let shutdownInitiated = false;

    const worker = createWorker({
      queue: queue,
      name: 'no-new-jobs-worker',
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processedJobs.push(job.data);

        if (job.data.taskType === 'first') {
          setTimeout(() => {
            shutdownInitiated = true;
            worker.close();
          }, 50);

          await new Promise((resolve) => setTimeout(resolve, 200));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    });

    const workerPromise = worker.run();

    await workerPromise;

    expect(processedJobs.length).toBeGreaterThanOrEqual(1);
    expect(processedJobs[0].taskType).toBe('first');
    expect(shutdownInitiated).toBe(true);

    const queueStats = await queue.getJobCounts();
    if (processedJobs.length === 1) {
      expect(queueStats.waiting).toBe(1);
    } else {
      expect(queueStats.waiting).toBe(0);
    }
  }, 10000);

  test('应当优雅地关闭 (should shutdown gracefully)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      logger: true,
    });
    let isCompleted = false;
    const worker = createWorker({
      queue: queue,
      logger: true,
      handler: async (_job) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        isCompleted = true;
      },
    });
    await queue.add({ groupId: 'test-group', data: { id: 1 } });
    worker.on('completed', (job) => {
      console.log('Completed', job.id);
    });
    worker.run();

    // 使用状态轮询等待任务开始处理
    await waitUntil(() => worker.isProcessing(), 2000);

    await worker.close(2000);
    expect(isCompleted).toBe(true);
    expect(worker.isProcessing()).toBe(false);
    expect(worker.getCurrentJob()).toBe(null);
    expect(worker.isClosed).toBe(true);
  });
});
