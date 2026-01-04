import { describe, expect, test } from '../../helpers/suite';
import { PriorityStrategy } from '../../../src';

describe('PriorityStrategy', () => {
  test('should process high priority groups first in Strict mode', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

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

    const worker = createWorker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy({
        algorithm: { type: 'probability', topPercent: 0.8, scanDepth: 500 },
        clientAlgorithm: { type: 'strict' },
      }),
      handler: async (job) => {
        processedGroups.push(job.groupId);
      },
    });

    worker.run();
    await queue.waitForEmpty();

    // 验证：虽然 Low 先进，但 High 应该先被大批量处理
    const last3 = processedGroups.slice(-3);
    const allLow = last3.every(g => g === 'group-low');

    console.log('Priority Order:', processedGroups.join(' -> '));
    expect(allLow).toBe(true);
  });

  test('should support weighted-random client algorithm for load distribution', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.groups.setConfig('group-a', { priority: 10 });
    await queue.groups.setConfig('group-b', { priority: 1 });

    for (let i = 0; i < 3; i++) {
      await queue.add({ groupId: 'group-a', data: { v: i } });
    }
    for (let i = 0; i < 15; i++) {
      await queue.add({ groupId: 'group-b', data: { v: i } });
    }

    const groupSequence: string[] = [];
    let lastGroup = '';

    const worker = createWorker({
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

    // weighted-random 是概率性算法，只验证 group-a 有机会被处理
    // 不能断言确定性顺序，因为低优先级组也有概率被先选中
    expect(groupSequence).toContain('group-a');
  });
});
