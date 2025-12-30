import { describe, expect, test } from '../helpers/suite';

describe('队列清理功能 (Queue.clean)', () => {
  test('应清理超过宽限期的已完成任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue<{ n: number }>({ keepCompleted: 100 });

    const worker = createWorker<{ n: number }>({
      queue,
      handler: async () => 'ok',
    });
    worker.run();

    await queue.add({ groupId: 'g1', data: { n: 1 } });
    await queue.add({ groupId: 'g1', data: { n: 2 } });
    await queue.waitForEmpty();

    const before = await queue.getCompletedCount();
    expect(before).toBeGreaterThanOrEqual(2);

    const cleaned = await queue.clean(0, Number.MAX_SAFE_INTEGER, 'completed');
    expect(cleaned).toBeGreaterThanOrEqual(2);

    const after = await queue.getCompletedCount();
    expect(after).toBe(0);
  });

  test('应清理超过宽限期的失败任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue<{ n: number }>({ keepFailed: 100 });

    const worker = createWorker<{ n: number }>({
      maxAttempts: 1,
      queue,
      handler: async () => {
        throw new Error('fail');
      },
    });
    worker.run();

    await queue.add({ groupId: 'g1', data: { n: 1 } });
    await queue.add({ groupId: 'g1', data: { n: 2 } });
    await queue.waitForEmpty();

    const before = await queue.getFailedCount();
    expect(before).toBeGreaterThanOrEqual(2);

    const cleaned = await queue.clean(0, Number.MAX_SAFE_INTEGER, 'failed');
    expect(cleaned).toBeGreaterThanOrEqual(2);

    const after = await queue.getFailedCount();
    expect(after).toBe(0);
  });

  test('应清理超过宽限期的延迟任务', async ({ createQueue }) => {
    const queue = createQueue<{ n: number }>({
      keepCompleted: 100,
      keepFailed: 100,
    });

    // Add two delayed jobs 10 minutes in the future
    await queue.add({ groupId: 'g1', data: { n: 1 }, delay: 600_000 });
    await queue.add({ groupId: 'g1', data: { n: 2 }, delay: 600_000 });

    const beforeDelayed = await queue.getDelayedCount();
    expect(beforeDelayed).toBeGreaterThanOrEqual(2);

    // Clean all delayed
    const cleaned = await queue.clean(
      -1 * 24 * 60 * 60 * 1000,
      Number.MAX_SAFE_INTEGER,
      'delayed',
    );
    expect(cleaned).toBeGreaterThanOrEqual(2);

    const afterDelayed = await queue.getDelayedCount();
    expect(afterDelayed).toBe(0);
  });
});
