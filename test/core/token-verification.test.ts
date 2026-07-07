import { describe, expect, test } from '../helpers/suite';
import { evalScript } from '../../src/lua/loader';

describe('Token 验证 (verifyToken)', () => {
  test('complete-job 应拒绝无效 token', async ({ createQueue, namespace, redis }) => {
    const queue = createQueue();
    await queue.add({ groupId: 'g1', data: { n: 1 } });

    const job = await queue.reserve();
    expect(job).toBeTruthy();
    expect(job!.token).toBeTruthy();

    const ns = `groupmq:${namespace}`;
    const now = Date.now();

    const result = await evalScript<number>(
      redis,
      'complete-job',
      [
        ns,
        job!.id,
        job!.groupId,
        'completed',
        String(now),
        'null',
        '10',
        '10',
        String(now),
        String(now),
        '1',
        '3',
        'wrong-token',
      ],
      1,
    );

    expect(result).toBe(0);
    const reservedJob = await queue.getJob(job!.id);
    expect(reservedJob!.status).not.toBe('completed');
    expect(await redis.zscore(`${ns}:processing`, job!.id)).not.toBeNull();
  });

  test('complete-and-reserve-next-with-metadata 应拒绝无效 token', async ({
    createQueue,
    namespace,
    redis,
  }) => {
    const queue = createQueue();
    await queue.add({ groupId: 'g1', data: { n: 1 } });

    const job = await queue.reserve();
    expect(job).toBeTruthy();

    const ns = `groupmq:${namespace}`;
    const now = Date.now();

    const result = await evalScript<string | null>(
      redis,
      'complete-and-reserve-next-with-metadata',
      [
        ns,
        job!.id,
        job!.groupId,
        'completed',
        String(now),
        'null',
        '10',
        '10',
        String(now),
        String(now),
        '1',
        '3',
        String(now),
        '60000',
        'wrong-token',
        'next-token',
      ],
      1,
    );

    expect(result).toBeNull();
    const reservedJob = await queue.getJob(job!.id);
    expect(reservedJob!.status).not.toBe('completed');
    expect(await redis.zscore(`${ns}:processing`, job!.id)).not.toBeNull();
  });

  test('complete-job 应接受有效 token', async ({ createQueue, namespace, redis }) => {
    const queue = createQueue();
    await queue.add({ groupId: 'g1', data: { n: 1 } });

    const job = await queue.reserve();
    expect(job).toBeTruthy();

    const ns = `groupmq:${namespace}`;
    const now = Date.now();

    const result = await evalScript<number>(
      redis,
      'complete-job',
      [
        ns,
        job!.id,
        job!.groupId,
        'completed',
        String(now),
        '"ok"',
        '10',
        '10',
        String(now),
        String(now),
        '1',
        '3',
        job!.token,
      ],
      1,
    );

    expect(result).toBe(1);
    expect((await queue.getJob(job!.id))!.status).toBe('completed');
  });
});
