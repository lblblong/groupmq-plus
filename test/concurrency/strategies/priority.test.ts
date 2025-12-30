import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker, PriorityStrategy } from '../../../src';
import { createRedis } from '../../helpers/redis';

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

    // 使用客户端 Strict 模式，且并发为 1 以验证顺序
    const worker = new Worker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy({
        algorithm: { type: 'probability', topPercent: 0.8, scanDepth: 500 },
        clientAlgorithm: { type: 'strict' },
      }),
      handler: async (job) => {
        processedGroups.push(job.groupId);
        // Strict 客户端算法会确保每次 acquireJob 时都按优先级排序
        // 由于并发为 1，Worker 会按顺序处理高优先级组
      },
    });

    worker.run();
    await queue.waitForEmpty();
    await worker.close();

    // 验证：虽然 Low 先进，但 High 应该先被大批量处理
    // 在 Strict 模式下，高优先级组应该在大多数情况下被优先处理

    // 我们检查最后处理的 3 个任务，必须是 Low (因为 High 早就跑完了)
    const last3 = processedGroups.slice(-3);
    const allLow = last3.every(g => g === 'group-low');

    console.log('Priority Order:', processedGroups.join(' -> '));
    expect(allLow).toBe(true);
  });

  it('should support weighted-random client algorithm for load distribution', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}:weighted-random`,
    });

    await queue.groups.setConfig('group-a', { priority: 10 });
    await queue.groups.setConfig('group-b', { priority: 1 });

    // 添加不同数量的任务以观察选择顺序
    // 添加更多 B 任务来测试加权随机是否能将 A 优先处理
    for (let i = 0; i < 3; i++) {
      await queue.add({ groupId: 'group-a', data: { v: i } });
    }
    for (let i = 0; i < 15; i++) {
      await queue.add({ groupId: 'group-b', data: { v: i } });
    }

    const groupSequence: string[] = [];
    let lastGroup = '';

    const worker = new Worker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy({
        algorithm: { type: 'probability', topPercent: 0.8, scanDepth: 500 },
        clientAlgorithm: { type: 'weighted-random', minWeightRatio: 0.1 },
      }),
      handler: async (job) => {
        if (job.groupId !== lastGroup) {
          groupSequence.push(job.groupId);
          lastGroup = job.groupId;
        }
      }
    });

    worker.run();
    await queue.waitForEmpty();
    await worker.close();

    // 验证：group-a 在组切换序列中应该出现（验证加权随机是否有效选择高优先级组）
    // 由于 A 优先级是 B 的 10 倍，A 应该至少有机会被选中
    expect(groupSequence).toContain('group-a');

    // 验证：第一个被选中的组应该是 A（高优先级）而不总是 B
    expect(groupSequence[0]).toBe('group-a');
  });
});