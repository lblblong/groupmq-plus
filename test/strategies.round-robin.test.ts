import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker, RoundRobinStrategy } from '../src';
import { createRedis } from './helpers/redis';

describe('RoundRobinStrategy', () => {
  const redis = createRedis();
  const namespace = `test:rr:${Date.now()}`;

  beforeAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  });

  it('should randomly select groups (distribution check)', async () => {
    // 这是一个统计测试：验证 RoundRobin 确实在随机选择 Group，而不是总是选第一个
    const queue = new Queue({
      redis,
      namespace: `${namespace}:distribution`,
    });

    const groupCount = 10;
    const groups: string[] = [];

    // 1. 创建 10 个 Group，每个 Group 放 1 个任务
    for (let i = 0; i < groupCount; i++) {
      const groupId = `group-${i}`;
      groups.push(groupId);
      await queue.add({ groupId, data: { id: i } });
    }

    const processedGroups: string[] = [];

    // 2. 启动 Worker，使用 RoundRobin 策略
    // 关键点：concurrency: 1 且任务很少，Worker 每次处理完一个任务后，
    // 因为该组没任务了，不会触发 "Atomic Chaining"，而是必须重新调用 acquireJob。
    // 这让我们能观测到 Strategy 的每一次选择。
    const worker = new Worker({
      queue,
      concurrency: 1,
      strategy: new RoundRobinStrategy({
        batchSize: 20, // 确保一次能拉取所有 Group 进行洗牌
      }),
      handler: async (job) => {
        processedGroups.push(job.groupId);
      },
    });

    worker.run();
    await queue.waitForEmpty();
    await worker.close();

    // 3. 验证结果
    expect(processedGroups.length).toBe(groupCount);

    // 验证：处理顺序不应该是严格的 group-0 -> group-1 -> ... -> group-9
    // 虽然理论上有极小概率随机成顺序，但在 10! 的排列中概率忽略不计
    const isPerfectlySequential = processedGroups.every(
      (g, i) => g === `group-${i}`
    );

    // 如果是 FIFO (默认策略)，这里通常是顺序的（取决于 Redis ZRANGE）
    // RoundRobin 应该打乱它
    console.log('Processed Order:', processedGroups.join(', '));
    expect(isPerfectlySequential).toBe(false);
  });

  it('should skip groups that have reached concurrency limit', async () => {
    const queue = new Queue({
      redis,
      namespace: `${namespace}:limit`,
    });

    // Group A 限制并发为 1
    await queue.groups.setConfig('group-limited', { concurrency: 1 });
    // Group B 不限制
    await queue.groups.setConfig('group-free', { concurrency: 10 });

    // 添加任务
    // 1. 先加一个长任务占住 limited 组
    await queue.add({
      groupId: 'group-limited',
      data: { id: 'blocker', duration: 300 }
    });
    // 2. 再加一个 limited 组的任务（应该被跳过）
    await queue.add({
      groupId: 'group-limited',
      data: { id: 'blocked' }
    });
    // 3. 加一个 free 组的任务（应该被处理）
    await queue.add({
      groupId: 'group-free',
      data: { id: 'free' }
    });

    const processed: string[] = [];

    const worker = new Worker({
      queue,
      concurrency: 5, // Worker 有能力并行
      strategy: new RoundRobinStrategy(),
      handler: async (job) => {
        if (job.data.duration) {
          await new Promise(r => setTimeout(r, job.data.duration));
        }
        processed.push(job.data.id);
      }
    });

    worker.run();

    // 等待足够时间让 free 完成，但 blocker 还没完成
    await new Promise(r => setTimeout(r, 200));

    // 验证：即使 RoundRobin 随机到了 group-limited，
    // 因为它满了，策略应该立即跳过它去处理 group-free
    expect(processed).toContain('free');

    // blocked 任务不应该在 blocker 之前完成 (FIFO 且并发为1)
    expect(processed).not.toContain('blocked');

    await queue.waitForEmpty();
    await worker.close();
  });
});