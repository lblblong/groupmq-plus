import Redis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://default@192.168.0.8:6380';

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
