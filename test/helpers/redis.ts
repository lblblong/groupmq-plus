import Redis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://default@127.0.0.1:6379';

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
