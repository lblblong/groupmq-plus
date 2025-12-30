import { afterAll, describe, expect, it } from 'vitest';
import { type Job, Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

describe('任务 CRUD 操作', () => {
  const namespace = `test:job:${Date.now()}`;

  afterAll(async () => {
    const redis = createRedis();
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  });

  it('应始终返回任务实体', async () => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `${namespace}:dedupe`,
      keepCompleted: 1,
    });
    const job = await q.add({ groupId: 'g1', data: { n: 1 } });

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

    const worker = new Worker({
      queue: q,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.run();
    let eventJob: Job | undefined;
    worker.on('completed', (job) => {
      eventJob = job as Job;
    });

    await q.waitForEmpty();

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

    const completedJob = await q.getJob(job.id);
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

    await worker.close();
    await redis.quit();
  });

  it('应通过队列和任务实例更新任务数据', async () => {
    const redis = createRedis();
    const q = new Queue<{ n: number }>({
      redis,
      namespace: `${namespace}:update`,
      keepCompleted: 1,
    });

    const job = await q.add({ groupId: 'g1', data: { n: 1 } });

    // Update via queue
    await q.updateData(job.id, { n: 2 });
    const j1 = await q.getJob(job.id);
    expect(j1.data).toEqual({ n: 2 });

    // Update via job instance
    await j1.updateData({ n: 3 });
    const j2 = await q.getJob(job.id);
    expect(j2.data).toEqual({ n: 3 });

    await redis.quit();
  });

  it('应在工作线程中处理更新的任务数据', async () => {
    const redis = createRedis();
    const q = new Queue<{ n: number }>({
      redis,
      namespace: `${namespace}:update-worker`,
      keepCompleted: 1,
    });

    const job = await q.add({ groupId: 'g1', data: { n: 1 } });

    // Update before a worker reserves it so the reserved payload reflects the change
    await q.updateData(job.id, { n: 99 });

    let seen: { n: number } | null = null;
    const worker = new Worker<{ n: number }>({
      queue: q,
      handler: async (reserved) => {
        seen = reserved.data;
        return 'ok';
      },
    });
    worker.run();

    await q.waitForEmpty();

    expect(seen).toEqual({ n: 99 });

    await worker.close();
    await redis.quit();
  });

  it('应提升延迟任务并立即处理它', async () => {
    const redis = createRedis();
    const q = new Queue<{ n: number }>({
      redis,
      namespace: `${namespace}:promote`,
    });

    const job = await q.add({ groupId: 'g1', data: { n: 1 }, delay: 60_000 });

    let seen: { n: number } | null = null;
    const worker = new Worker<{ n: number }>({
      queue: q,
      handler: async (reserved) => {
        seen = reserved.data;
        return 'ok';
      },
    });
    worker.run();

    // Promote to run now
    await q.promote(job.id);
    await q.waitForEmpty();

    expect(seen).toEqual({ n: 1 });

    await worker.close();
    await redis.quit();
  });

  it('应移除等待中的任务而不处理它', async () => {
    const redis = createRedis();
    const q = new Queue<{ n: number }>({
      redis,
      namespace: `${namespace}:remove`,
    });

    const job = await q.add({ groupId: 'g1', data: { n: 1 } });

    // Remove the job before worker starts
    const removed = await q.remove(job.id);
    expect(removed).toBe(true);

    let processed = false;
    const worker = new Worker<{ n: number }>({
      queue: q,
      handler: async () => {
        processed = true;
        return 'ok';
      },
    });
    worker.run();

    // Wait a bit and ensure nothing processed
    await q.waitForEmpty(); // queue should be empty since we removed
    expect(processed).toBe(false);

    await worker.close();
    await redis.quit();
  });

  it('应为失败的任务提供错误信息', async () => {
    const redis = createRedis();
    const q = new Queue({
      redis,
      namespace: `${namespace}:failed`,
      keepFailed: 1,
    });
    const job = await q.add({ groupId: 'g1', data: { n: 1 } });

    const worker = new Worker({
      queue: q,
      handler: async () => {
        throw new Error('Failed job');
      },
    });

    worker.run();

    await q.waitForEmpty();

    const failedJob = await q.getJob(job.id);
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
