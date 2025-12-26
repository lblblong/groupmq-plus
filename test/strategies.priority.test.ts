import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker, PriorityStrategy } from '../src';
import { createRedis } from './helpers/redis';

describe('PriorityStrategy', () => {
  const redis = createRedis();
  const namespace = `test:priority:${Date.now()}`;

  beforeAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  });

  it('should process high priority groups first in Strict mode', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}:strict`,
    });

    await queue.groups.setConfig('group-high', { priority: 100 });
    await queue.groups.setConfig('group-low', { priority: 1 });

    // 先添加低优先级任务
    for (let i = 0; i < 5; i++) {
      await queue.add({ groupId: 'group-low', data: { id: i } });
    }
    // 再添加高优先级任务
    for (let i = 0; i < 5; i++) {
      await queue.add({ groupId: 'group-high', data: { id: i } });
    }

    const processedGroups: string[] = [];

    // 使用 Strict 模式，且并发为 1 以验证顺序
    const worker = new Worker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy({
        algorithm: { type: 'strict' },
        cacheTtlMs: 0, // 禁用缓存确保立即生效
      }),
      handler: async (job) => {
        processedGroups.push(job.groupId);
        // 避免 Worker 内部连招 (Chain) 导致测试不准确
        // 这里的技巧是：每次处理完稍微等一下，让 Strategy 重新介入
        // 但其实 Worker 内部逻辑倾向于 Chain，
        // 不过由于我们有两个不同的组，Strict 策略会在每次 acquireJob 时
        // 强制把 High 组排在 Low 组前面。
        // 只要 Worker 释放了 Low 组（比如处理完一个），下一次 acquireJob 肯定选 High。
      },
    });

    worker.run();
    await queue.waitForEmpty();
    await worker.close();

    // 验证：虽然 Low 先进，但 High 应该先被大批量处理
    // 注意：如果是 Worker 刚启动时，可能先抓到了 Low 的一个任务（因为 FIFO 已经在 Ready 队列头）
    // 但随后的任务应该优先处理 High

    // 我们检查最后处理的 3 个任务，必须是 Low (因为 High 早就跑完了)
    const last3 = processedGroups.slice(-3);
    const allLow = last3.every(g => g === 'group-low');

    console.log('Priority Order:', processedGroups.join(' -> '));
    expect(allLow).toBe(true);
  });

  it('should support dynamic priority via callback', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}:dynamic`,
    });

    await queue.add({ groupId: 'group-a', data: { v: 1 } });
    await queue.add({ groupId: 'group-b', data: { v: 2 } });

    const processed: string[] = [];

    const worker = new Worker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy({
        algorithm: { type: 'strict' },
        onGetPriority: (groupId) => {
          // 动态让 B 优先
          return groupId === 'group-b' ? 10 : 1;
        }
      }),
      handler: async (job) => {
        processed.push(job.groupId);
      }
    });

    worker.run();
    await queue.waitForEmpty();
    await worker.close();

    // 期望 B 先于 A (尽管 A 可能先入队)
    // 注意：如果 A 已经极其靠前，Worker 第一次 fetch 可能会拿到 A。
    // 这个测试依赖于 Strategy 在 fetch 时的重排序能力。
    // 如果 A 和 B 都在 Ready 队列，Strategy 会把 B 排前面。
    expect(processed).toEqual(['group-b', 'group-a']);
  });
});