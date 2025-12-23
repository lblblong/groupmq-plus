import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../src';
import { PriorityStrategy } from '../src/strategies/priority-strategy';
import { createRedis } from './helpers/redis';

describe('PriorityStrategy', () => {
  const redis = createRedis();
  const namespace = `test:priority:${Date.now()}`;

  beforeEach(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  });

  describe('Strict Algorithm', () => {
    it('should always select highest priority group', async () => {
      const queue = new Queue({ redis, namespace: `${namespace}:strict` });

      // 设置优先级: vip=100, normal=10, free=1
      await queue.setGroupConfig('vip', { priority: 100 });
      await queue.setGroupConfig('normal', { priority: 10 });
      await queue.setGroupConfig('free', { priority: 1 });

      // 添加任务 (故意先添加低优先级的)
      await queue.add({ groupId: 'free', data: { type: 'free' } });
      await queue.add({ groupId: 'normal', data: { type: 'normal' } });
      await queue.add({ groupId: 'vip', data: { type: 'vip' } });

      const strategy = new PriorityStrategy({ algorithm: { type: 'strict' } });
      const processed: string[] = [];

      const worker = new Worker({
        queue,
        strategy,
        strategyPollInterval: 10,
        handler: async (job) => {
          processed.push(job.data.type);
        },
      });

      await new Promise(r => setTimeout(r, 1000));
      await worker.close();

      // 严格优先级: VIP 应该最先被处理
      expect(processed[0]).toBe('vip');
      expect(processed.length).toBe(3);
    });
  });

  describe('Weighted Random Algorithm', () => {
    it('should give low priority groups a chance', async () => {
      const queue = new Queue({ redis, namespace: `${namespace}:weighted` });

      await queue.setGroupConfig('high', { priority: 100 });
      await queue.setGroupConfig('low', { priority: 1 });

      // 添加大量任务
      for (let i = 0; i < 50; i++) {
        await queue.add({ groupId: 'high', data: { type: 'high', i } });
        await queue.add({ groupId: 'low', data: { type: 'low', i } });
      }

      const strategy = new PriorityStrategy({
        algorithm: { type: 'weighted-random', minWeightRatio: 0.1 },
      });

      const processed: string[] = [];
      const worker = new Worker({
        queue,
        strategy,
        strategyPollInterval: 5,
        handler: async (job) => {
          processed.push(job.data.type);
          // 添加一点处理时间，让测试更真实
          await new Promise(r => setTimeout(r, 20));
        },
      });

      // 只等待部分任务处理完成，这样才能观察到优先级差异
      await new Promise(r => setTimeout(r, 1500));
      await worker.close();

      const highCount = processed.filter(t => t === 'high').length;
      const lowCount = processed.filter(t => t === 'low').length;

      console.log(`High: ${highCount}, Low: ${lowCount}, Total: ${processed.length}`);

      // 低优先级组应该也有机会被处理 (至少处理了一些)
      expect(lowCount).toBeGreaterThan(0);
      // 高优先级组应该处理更多 (或者至少相等，因为 weighted-random 有随机性)
      expect(highCount).toBeGreaterThanOrEqual(lowCount);
    });
  });

  describe('Aging Algorithm', () => {
    it('should eventually process old low-priority jobs', async () => {
      const queue = new Queue({ redis, namespace: `${namespace}:aging` });

      await queue.setGroupConfig('high', { priority: 100 });
      await queue.setGroupConfig('low', { priority: 1 });

      // 先添加低优先级任务
      await queue.add({ groupId: 'low', data: { type: 'low-old' } });
      
      // 等待一段时间让任务"老化"
      await new Promise(r => setTimeout(r, 200));
      
      // 再添加高优先级任务
      await queue.add({ groupId: 'high', data: { type: 'high-new' } });

      const strategy = new PriorityStrategy({
        algorithm: { type: 'aging', intervalMs: 50 }, // 每50ms增加1点优先级
      });

      const processed: string[] = [];
      const worker = new Worker({
        queue,
        strategy,
        strategyPollInterval: 10,
        handler: async (job) => {
          processed.push(job.data.type);
        },
      });

      await new Promise(r => setTimeout(r, 500));
      await worker.close();

      expect(processed.length).toBe(2);
      // 由于 aging 算法，老任务的优先级会提升，可能先被处理
      // 这里只验证两个任务都被处理了
      expect(processed).toContain('low-old');
      expect(processed).toContain('high-new');
    });
  });

  describe('setPriority / clearPriority', () => {
    it('should override Redis config with manual priority', async () => {
      const queue = new Queue({ redis, namespace: `${namespace}:override` });

      // Redis 配置: normal 优先级低
      await queue.setGroupConfig('normal', { priority: 1 });
      await queue.setGroupConfig('vip', { priority: 100 });

      await queue.add({ groupId: 'normal', data: { type: 'normal' } });
      await queue.add({ groupId: 'vip', data: { type: 'vip' } });

      const strategy = new PriorityStrategy({ algorithm: { type: 'strict' } });
      
      // 手动覆盖: 让 normal 优先级最高
      strategy.setPriority('normal', 9999);

      const processed: string[] = [];
      const worker = new Worker({
        queue,
        strategy,
        strategyPollInterval: 10,
        handler: async (job) => {
          processed.push(job.data.type);
        },
      });

      await new Promise(r => setTimeout(r, 500));
      await worker.close();

      // normal 应该先被处理 (因为手动覆盖了优先级)
      expect(processed[0]).toBe('normal');
    });
  });

  describe('onGetPriority callback', () => {
    it('should use custom priority calculation', async () => {
      const queue = new Queue({ redis, namespace: `${namespace}:callback` });

      await queue.setGroupConfig('user:free:1', { priority: 1 });
      await queue.setGroupConfig('user:vip:2', { priority: 1 }); // 相同的基础优先级

      await queue.add({ groupId: 'user:free:1', data: { type: 'free' } });
      await queue.add({ groupId: 'user:vip:2', data: { type: 'vip' } });

      const strategy = new PriorityStrategy({
        algorithm: { type: 'strict' },
        onGetPriority: (groupId, config) => {
          // VIP 用户优先级 x10
          if (groupId.includes(':vip:')) {
            return config.priority * 10;
          }
          return config.priority;
        },
      });

      const processed: string[] = [];
      const worker = new Worker({
        queue,
        strategy,
        strategyPollInterval: 10,
        handler: async (job) => {
          processed.push(job.data.type);
        },
      });

      await new Promise(r => setTimeout(r, 500));
      await worker.close();

      // VIP 应该先被处理
      expect(processed[0]).toBe('vip');
    });
  });
});
