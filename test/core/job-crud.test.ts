import { describe, expect, test } from '../helpers/suite';
import type { Job } from '../../src';

describe('任务 CRUD 操作', () => {
  test('应始终返回任务实体', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ keepCompleted: 1 });
    const job = await queue.add({ groupId: 'g1', data: { n: 1 } });

    expect(job).toBeDefined();
    expect(job.id).toBeDefined();
    expect(job.groupId).toBe('g1');
    expect(job.data).toBeDefined();
    expect(job.data.n).toBe(1);
    expect(job.status).toBe('waiting');
    expect(job.processedOn).toBeUndefined();
    expect(job.finishedOn).toBeUndefined();
    expect(job.failedReason).toBeUndefined();
    expect(job.returnvalue).toBeUndefined();
    expect(job.timestamp).toBeDefined();
    expect(job.orderMs).toBeDefined();
    expect(job.attemptsMade).toBe(0);
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.delay).toBeUndefined();

    let eventJob: Job | undefined;
    const worker = createWorker({
      queue,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.on('completed', (j) => {
      eventJob = j as Job;
    });
    worker.run();

    await queue.waitForEmpty();

    if (eventJob) {
      expect(eventJob.processedOn).toBeDefined();
      expect(eventJob.finishedOn).toBeDefined();
      const now = Date.now();
      expect(typeof (eventJob.processedOn as number)).toBe('number');
      expect(typeof (eventJob.finishedOn as number)).toBe('number');
      expect((eventJob.processedOn as number) > 1e12).toBe(true);
      expect((eventJob.finishedOn as number) > 1e12).toBe(true);
      expect((eventJob.processedOn as number) <= now).toBe(true);
      expect((eventJob.finishedOn as number) <= now).toBe(true);
      expect(
        (eventJob.finishedOn as number) >= (eventJob.processedOn as number),
      ).toBe(true);
      expect(eventJob.failedReason).toBeUndefined();
      expect(eventJob.data).toEqual({ n: 1 });
      expect(eventJob.returnvalue).toEqual('return value from worker');
    } else {
      throw new Error('Completed job event not received');
    }

    const completedJob = await queue.getJob(job.id);
    expect(completedJob).toBeDefined();
    expect(completedJob.processedOn).toBeDefined();
    expect(completedJob.finishedOn).toBeDefined();
    const now2 = Date.now();
    expect(typeof (completedJob.processedOn as number)).toBe('number');
    expect(typeof (completedJob.finishedOn as number)).toBe('number');
    expect((completedJob.processedOn as number) > 1e12).toBe(true);
    expect((completedJob.finishedOn as number) > 1e12).toBe(true);
    expect((completedJob.processedOn as number) <= now2).toBe(true);
    expect((completedJob.finishedOn as number) <= now2).toBe(true);
    expect(
      (completedJob.finishedOn as number) >=
      (completedJob.processedOn as number),
    ).toBe(true);
    expect(completedJob.failedReason).toBeUndefined();
    expect(completedJob.data).toEqual({ n: 1 });
    expect(completedJob.returnvalue).toEqual('return value from worker');
  });

  test('应通过队列和任务实例更新任务数据', async ({ createQueue }) => {
    const queue = createQueue<{ n: number }>({ keepCompleted: 1 });

    const job = await queue.add({ groupId: 'g1', data: { n: 1 } });

    // Update via queue
    await queue.updateData(job.id, { n: 2 });
    const j1 = await queue.getJob(job.id);
    expect(j1.data).toEqual({ n: 2 });

    // Update via job instance
    await j1.updateData({ n: 3 });
    const j2 = await queue.getJob(job.id);
    expect(j2.data).toEqual({ n: 3 });
  });

  test('应在工作线程中处理更新的任务数据', async ({ createQueue, createWorker }) => {
    const queue = createQueue<{ n: number }>({ keepCompleted: 1 });

    const job = await queue.add({ groupId: 'g1', data: { n: 1 } });

    // Update before a worker reserves it
    await queue.updateData(job.id, { n: 99 });

    let seen: { n: number } | null = null;
    const worker = createWorker<{ n: number }>({
      queue,
      handler: async (reserved) => {
        seen = reserved.data;
        return 'ok';
      },
    });
    worker.run();

    await queue.waitForEmpty();

    expect(seen).toEqual({ n: 99 });
  });

  test('应提升延迟任务并立即处理它', async ({ createQueue, createWorker }) => {
    const queue = createQueue<{ n: number }>();

    const job = await queue.add({ groupId: 'g1', data: { n: 1 }, delay: 60_000 });

    let seen: { n: number } | null = null;
    const worker = createWorker<{ n: number }>({
      queue,
      handler: async (reserved) => {
        seen = reserved.data;
        return 'ok';
      },
    });
    worker.run();

    // Promote to run now
    await queue.promote(job.id);
    await queue.waitForEmpty();

    expect(seen).toEqual({ n: 1 });
  });

  test('应移除等待中的任务而不处理它', async ({ createQueue, createWorker }) => {
    const queue = createQueue<{ n: number }>();

    const job = await queue.add({ groupId: 'g1', data: { n: 1 } });

    // Remove the job before worker starts
    const removed = await queue.remove(job.id);
    expect(removed).toBe(true);

    let processed = false;
    const worker = createWorker<{ n: number }>({
      queue,
      handler: async () => {
        processed = true;
        return 'ok';
      },
    });
    worker.run();

    await queue.waitForEmpty();
    expect(processed).toBe(false);
  });

  test('应为失败的任务提供错误信息', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ keepFailed: 1 });
    const job = await queue.add({ groupId: 'g1', data: { n: 1 } });

    const worker = createWorker({
      queue,
      handler: async () => {
        throw new Error('Failed job');
      },
    });
    worker.run();

    await queue.waitForEmpty();

    const failedJob = await queue.getJob(job.id);
    expect(failedJob).toBeDefined();
    expect(failedJob.failedReason).toEqual('Failed job');
    expect(failedJob.stacktrace).toBeDefined();
    expect(String(failedJob.stacktrace)).toMatch(/^Error: Failed job\n/);
    expect(String(failedJob.stacktrace)).toMatch(
      /at (\w+)\.(\w+) \(.*\.ts:\d+:\d+\)/,
    );
    // Validate timestamps for failed jobs as Unix ms
    const now3 = Date.now();
    expect(failedJob.processedOn).toBeDefined();
    expect(failedJob.finishedOn).toBeDefined();
    expect(typeof (failedJob.processedOn as number)).toBe('number');
    expect(typeof (failedJob.finishedOn as number)).toBe('number');
    expect((failedJob.processedOn as number) > 1e12).toBe(true);
    expect((failedJob.finishedOn as number) > 1e12).toBe(true);
    expect((failedJob.processedOn as number) <= now3).toBe(true);
    expect((failedJob.finishedOn as number) <= now3).toBe(true);
    expect(
      (failedJob.finishedOn as number) >= (failedJob.processedOn as number),
    ).toBe(true);
  });
});
