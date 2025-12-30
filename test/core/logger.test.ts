import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import winston from 'winston';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

describe('日志记录器 (logger)', () => {
  const redis = createRedis();
  const namespace = `test:q1:${Date.now()}`;

  beforeAll(async () => {
    // flush only this namespace keys (best-effort)
    const keys = await redis.keys(`${namespace}*`);
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('应当支持 pino 日志记录器 (pino)', () => {
    const logger = pino();
    const q = new Queue({ redis, namespace, jobTimeoutMs: 5000 });
    const worker = new Worker({
      logger,
      queue: q,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.run();
  });

  it('应当支持 winston 日志记录器 (winston)', () => {
    const logger = winston.createLogger();
    const q = new Queue({ redis, namespace, jobTimeoutMs: 5000 });
    const worker = new Worker({
      logger,
      queue: q,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.run();
  });
});
