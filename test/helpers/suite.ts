import { test as base } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from '../../src';
import { createRedis } from './redis';
import type { Redis } from 'ioredis';

// 定义测试上下文中可用的扩展属性
interface QueueFixtures {
  // 唯一的命名空间，例如: test:uuid-v4
  namespace: string;
  // 独立的 Redis 客户端
  redis: Redis;
  // 预配置好的 Queue 实例
  queue: Queue;
}

export const test = base.extend<QueueFixtures>({
  // 1. 自动生成唯一命名空间
  namespace: async ({ }, use) => {
    // 使用 UUID 彻底杜绝碰撞，比 Date.now() 更安全
    const ns = `test:${randomUUID()}`;
    await use(ns);
  },

  // 2. 自动管理 Redis 连接
  redis: async ({ }, use) => {
    const client = createRedis();
    await use(client);
    // 测试结束后自动断开
    await client.quit();
  },

  // 3. 自动创建和清理 Queue，并处理 Redis 数据残留
  queue: async ({ namespace, redis }, use) => {
    // 清理该命名空间下可能存在的旧数据（理论上 UUID 不会有旧数据，但在开发调试时很有用）
    const keys = await redis.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis.del(keys);

    const q = new Queue({
      redis,
      namespace,
      // 可以在这里设置默认的测试配置
      keepCompleted: 10,
      keepFailed: 10,
    });

    await use(q);

    // 测试结束后的自动清理逻辑
    await q.close(); // 关闭连接

    // 彻底清理 Redis 中的数据，防止污染
    const cleanupKeys = await redis.keys(`groupmq:${namespace}*`);
    if (cleanupKeys.length) await redis.del(cleanupKeys);
  },
});

// 导出 expect 以便在测试文件中直接使用
export { expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';