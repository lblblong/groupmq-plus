import { describe, expect, test } from '../helpers/suite';

describe('幂等性入队 - 可选 jobId', () => {
  test('应忽略具有相同 jobId 的重复添加并返回相同 id', async ({ createQueue, createWorker }) => {
    const queue = createQueue();
    const customId = 'my-fixed-id';

    const job1 = await queue.add({
      groupId: 'g1',
      data: { n: 1 },
      jobId: customId,
    });
    const job2 = await queue.add({
      groupId: 'g1',
      data: { n: 2 },
      jobId: customId,
    });

    expect(job1.id).toBe(customId);
    expect(job2.id).toBe(customId);

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data as any);
      },
    });
    worker.run();

    await queue.waitForEmpty();

    expect(processed.length).toBe(1);
    expect(processed[0]).toEqual({ n: 1 });
  });

  test('未提供 jobId 时应生成 UUID', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    const job = await queue.add({ groupId: 'g1', data: { a: 1 } });

    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.id);
      },
    });
    worker.run();

    await queue.waitForEmpty();

    expect(processed).toEqual([job.id]);
  });

  test('任务被保留策略删除后应允许 jobId 重用', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      keepCompleted: 0,
      keepFailed: 0,
    });

    const customId = 'reusable-id';

    const job = await queue.add({
      groupId: 'g1',
      data: { n: 1 },
      jobId: customId,
    });
    expect(job.id).toBe(customId);

    const processed: any[] = [];
    const worker1 = createWorker({
      name: 'worker1',
      queue,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push({
          ...job.data,
          worker: 'worker1',
        });
      },
    });
    worker1.run();

    await queue.waitForEmpty();
    await worker1.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const job2 = await queue.add({
      groupId: 'g1',
      data: { n: 2 },
      jobId: customId,
    });
    expect(job2.id).toBe(customId);

    const worker2 = createWorker({
      name: 'worker2',
      queue,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push({
          ...job.data,
          worker: 'worker2',
        });
      },
    });
    worker2.run();

    await queue.waitForEmpty();

    expect(processed).toEqual([
      { n: 1, worker: 'worker1' },
      { n: 2, worker: 'worker2' },
    ]);
  });
});
