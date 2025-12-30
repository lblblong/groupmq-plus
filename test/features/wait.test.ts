import { describe, expect, test } from '../helpers/suite';

describe('等待直到完成功能 (waitUntilFinished)', () => {
  test('任务完成时应当解决 (resolves when a job completes)', async ({ createQueue, createWorker }) => {
    const q = createQueue<{ value: number }>({ keepCompleted: 1 });

    const worker = createWorker<{ value: number }>({
      queue: q,
      handler: async (job) => job.data.value * 2,
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: { value: 21 } });

    const result = await job.waitUntilFinished(2000);
    expect(result).toBe(42);
  });

  test('任务失败时应当拒绝 (rejects when a job fails)', async ({ createQueue, createWorker }) => {
    const q = createQueue({
      keepFailed: 1,
      maxAttempts: 1,
    });

    const worker = createWorker({
      queue: q,
      handler: async () => {
        throw new Error('boom');
      },
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: { value: 1 } });

    await expect(job.waitUntilFinished(5000)).rejects.toThrow('boom');
  });

  test('应当解决同一任务的多个并发等待者 (resolves multiple concurrent waiters for the same job)', async ({ createQueue, createWorker }) => {
    const q = createQueue({ keepCompleted: 1 });

    const worker = createWorker({
      queue: q,
      handler: async () => 'ok',
    });
    worker.run();

    const job = await q.add({ groupId: 'g1', data: {} });

    const waiter1 = job.waitUntilFinished(2000);
    const waiter2 = q.waitUntilFinished(job.id, 2000);

    const [result1, result2] = await Promise.all([waiter1, waiter2]);
    expect(result1).toBe('ok');
    expect(result2).toBe('ok');
  });
});
