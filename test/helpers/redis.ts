import Redis from 'ioredis';

// 优先级：显式环境变量 > .env.local 中的 VITE_REDIS_URL > 本地默认
export const REDIS_URL =
  process.env.GROUPMQ_TEST_REDIS_URL ??
  process.env.VITE_REDIS_URL ??
  'redis://default@127.0.0.1:6379';

export function createRedis(options: any = {}) {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    ...options,
  });
}

export async function cleanupRedis(namespace: string) {
  const redis = createRedis();
  const keys = await redis.keys(`${namespace}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
}
