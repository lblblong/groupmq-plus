import { test as base } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type QueueOptions, type WorkerOptions } from '../../src';
import { createRedis } from './redis';
import type { Redis } from 'ioredis';

// 定义资源接口，用于自动清理
interface Disposable {
  close: (timeout?: number) => Promise<void>;
}

interface GroupMQFixtures {
  // 基础资源
  namespace: string;
  redis: Redis;

  // 工厂方法 (会自动清理创建的资源)
  createQueue: <T = any>(options?: Partial<QueueOptions>) => Queue<T>;
  // 修复：WorkerOptions 需要泛型参数，使用 any 兼容所有情况
  createWorker: <T = any>(options: WorkerOptions<T>) => Worker<T>;

  // 便捷访问 (使用默认配置的单例)
  queue: Queue;
}

export const test = base.extend<GroupMQFixtures>({
  // 1. 命名空间隔离
  namespace: async ({ }, use) => {
    const ns = `test:${randomUUID()}`;
    await use(ns);
  },

  // 2. Redis 连接管理
  redis: async ({ }, use) => {
    const client = createRedis();
    await use(client);
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  },

  // 3. Queue 工厂与自动清理
  createQueue: async ({ redis, namespace }, use) => {
    const disposables: Disposable[] = [];

    const factory = (options: Partial<QueueOptions> = {}) => {
      // 自动注入隔离的 redis 和 namespace，但允许用户覆盖
      const q = new Queue({
        redis,
        namespace,
        keepCompleted: 10,
        keepFailed: 10,
        ...options,
      });
      disposables.push(q);
      return q;
    };

    await use(factory);

    // 测试结束后：倒序关闭资源
    for (const item of disposables.reverse()) {
      try {
        await item.close();
      } catch (err) {
        // 忽略关闭错误（连接可能已关闭）
      }
    }

    // 清理 Redis 数据（忽略连接已关闭的错误）
    try {
      const keys = await redis.keys(`groupmq:${namespace}*`);
      if (keys.length) await redis.del(keys);
    } catch (err) {
      // 忽略清理错误（连接可能已关闭）
    }
  },

  // 4. Worker 工厂与自动清理
  createWorker: async ({ }, use) => {
    const disposables: Disposable[] = [];

    // 修复：添加 <any> 泛型参数
    const factory = (options: WorkerOptions<any>) => {
      const w = new Worker(options);
      disposables.push(w);
      return w;
    };

    await use(factory);

    // 测试结束后：倒序关闭 Worker
    for (const item of disposables.reverse()) {
      try {
        await item.close();
      } catch (err) {
        // 忽略关闭错误（连接可能已关闭）
      }
    }
  },

  // 5. 便捷的默认 Queue 实例
  queue: async ({ createQueue }, use) => {
    const q = createQueue();
    await use(q);
  },
});

export { expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';