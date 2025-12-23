import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../src';
import { createRedis } from './helpers/redis';

describe('basic per-group FIFO and parallelism', () => {
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

  it('should have a name', () => {
    const q = new Queue({ redis, namespace, jobTimeoutMs: 5000 });
    expect(q.name).toBe(namespace);
  });
});
