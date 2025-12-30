import { describe, expect, test } from '../helpers/suite';
import { Job } from '../../src';

describe('数据完整性与边缘情况 (Data Integrity & Edge Cases)', () => {
  test('应当处理空载荷和空值 (should handle empty payloads and null values)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const testCases = [
      { id: 1, data: null },
      { id: 2, data: undefined },
      { id: 3, data: {} },
      { id: 4, data: [] },
      { id: 5, data: '' },
      { id: 6, data: 0 },
      { id: 7, data: false },
    ];

    for (const testCase of testCases) {
      await q.add({
        groupId: `empty-group-${testCase.id}`,
        data: testCase.data,
        orderMs: testCase.id,
      });
    }

    const processed: any[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data as any);
      },
    });

    worker.run();
    await q.waitForEmpty();

    expect(processed.length).toBe(testCases.length);
    expect(processed).toContain(null);
    expect(processed).toEqual([null, null, {}, [], '', 0, false]);
  });

  test('应当处理极大的载荷 (should handle extremely large payloads)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const largePayload = {
      id: 'large-payload',
      data: 'x'.repeat(1024 * 1024),
      metadata: {
        timestamp: Date.now(),
        nested: {
          array: new Array(1000).fill('item'),
          object: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [`key${i}`, `value${i}`]),
          ),
        },
      },
    };

    await q.add({
      groupId: 'large-group',
      data: largePayload,
    });

    let processedData: any = null;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processedData = job.data;
      },
    });

    worker.run();
    await q.waitForEmpty();

    expect(processedData).not.toBeNull();
    expect(processedData.id).toBe('large-payload');
    expect(processedData.data.length).toBe(1024 * 1024);
    expect(processedData.metadata.nested.array.length).toBe(1000);
  });

  test('应当处理载荷中的特殊字符和 Unicode (should handle special characters and unicode in payloads)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const specialPayloads = [
      { id: 1, text: 'Hello 🌍 World! 你好世界 🚀' },
      { id: 2, text: 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?' },
      { id: 3, text: 'Emojis: 😀😃😄😁😆😅😂🤣☺️😊' },
      { id: 4, text: 'Multi-line\nstring\nwith\ttabs' },
      { id: 5, text: 'Quotes: "double" \'single\' `backtick`' },
      { id: 6, text: 'JSON-like: {"key": "value", "number": 123}' },
      { id: 7, text: 'Arabic: مرحبا بالعالم' },
      { id: 8, text: 'Russian: Привет мир' },
      { id: 9, text: 'Japanese: こんにちは世界' },
    ];

    for (const payload of specialPayloads) {
      await q.add({
        groupId: `unicode-group-${payload.id}`,
        data: payload,
        orderMs: payload.id,
      });
    }

    const processed: any[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data as any);
      },
    });

    worker.run();

    const startTime = Date.now();
    while (
      processed.length < specialPayloads.length &&
      Date.now() - startTime < 5000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(processed.length).toBe(specialPayloads.length);

    processed.forEach((payload, index) => {
      expect(payload.text).toBe(specialPayloads[index].text);
    });
  });

  test('应当优雅地处理格式错误或损坏的数据 (should handle malformed or corrupted data gracefully)', async ({ redis, createQueue, createWorker }) => {
    const q = createQueue();

    const queueNamespace = q.namespace;
    const jobKey = `${queueNamespace}:job:corrupted-job`;
    const groupKey = `${queueNamespace}:g:corrupted-group`;
    const readyKey = `${queueNamespace}:ready`;

    await redis.hmset(jobKey, {
      id: 'corrupted-job',
      groupId: 'corrupted-group',
      data: 'invalid-json{malformed',
      attempts: 'not-a-number',
      maxAttempts: '3',
      seq: '1',
      timestamp: 'invalid-timestamp',
      orderMs: '1',
      score: 'not-a-score',
    });

    await redis.zadd(groupKey, 1, 'corrupted-job');
    await redis.zadd(readyKey, 1, 'corrupted-group');

    const errors: string[] = [];
    const processed: any[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data as any);
      },
      onError: (err) => {
        errors.push((err as Error).message);
      },
    });

    worker.run();
    await q.waitForEmpty();

    expect(processed.length).toBe(1);
    expect(processed[0]).toBeNull();
  });

  test('应当处理极长的组 ID 和任务 ID (should handle extremely long group IDs and job IDs)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const longGroupId = `group-${'x'.repeat(500)}`;
    const longData = {
      veryLongProperty: 'y'.repeat(1000),
      id: 'long-test',
    };

    await q.add({
      groupId: longGroupId,
      data: longData,
    });

    let processedJob: Job | null = null;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processedJob = job;
      },
    });

    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processedJob).not.toBeNull();
    expect(processedJob!.groupId).toBe(longGroupId);
    expect(processedJob!.data.veryLongProperty.length).toBe(1000);
  });

  test('应当处理快速 worker 启动/停止循环 (should handle rapid worker start/stop cycles)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    for (let i = 0; i < 10; i++) {
      await q.add({
        groupId: 'rapid-group',
        data: { id: i },
        orderMs: i,
      });
    }

    const processed: number[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      const worker = createWorker({
        queue: q,
        blockingTimeoutSec: 1,
        handler: async (job) => {
          processed.push((job.data as any).id);
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });

      worker.run();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await worker.close();
    }

    const finalWorker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
    });

    finalWorker.run();
    await q.waitForEmpty();

    expect(processed.length).toBe(10);
    expect(new Set(processed).size).toBe(10);
  });

  test('应当处理时钟偏斜和基于时间的边缘情况 (should handle clock skew and time-based edge cases)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    const timeTestCases = [
      { id: 1, orderMs: 0 },
      { id: 2, orderMs: Date.now() - 86400000 },
      { id: 3, orderMs: Date.now() },
      { id: 4, orderMs: Date.now() + 86400000 },
      { id: 5, orderMs: Number.MAX_SAFE_INTEGER },
    ];

    for (const testCase of timeTestCases) {
      await q.add({
        groupId: 'time-group',
        data: { id: testCase.id },
        orderMs: testCase.orderMs,
      });
    }

    const processed: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push((job.data as any).id);
      },
    });

    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processed.length).toBe(5);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
  });

  test('应当处理载荷中的循环引用 (should handle circular references in payloads)', async ({ createQueue }) => {
    const q = createQueue();

    const circularObj: any = { id: 'circular-test' };
    circularObj.self = circularObj;

    let enqueueFailed = false;
    try {
      await q.add({
        groupId: 'circular-group',
        data: circularObj,
      });
    } catch (err) {
      enqueueFailed = true;
      expect((err as Error).message).toContain('circular');
    }

    expect(enqueueFailed).toBe(true);
  });

  test('应当处理零和负的可见性超时 (should handle zero and negative visibility timeouts)', async ({ redis, createQueue }) => {
    const q1 = createQueue({
      jobTimeoutMs: 1,
    });

    await q1.add({ groupId: 'zero-group', data: { test: 'zero' } });

    const job1 = await q1.reserve();
    expect(job1).not.toBeNull();

    const q2 = createQueue({
      jobTimeoutMs: -1000,
    });

    await q2.add({ groupId: 'neg-group', data: { test: 'negative' } });

    const job2 = await q2.reserve();
    expect(job2).not.toBeNull();
  });

  test('应当处理断开连接的 Redis 上的队列操作 (should handle queue operations on disconnected Redis)', async ({ redis, createQueue }) => {
    const q = createQueue();

    await redis.disconnect();

    let enqueueError = null;
    let reserveError = null;

    try {
      await q.add({ groupId: 'disc-group', data: { test: 'disconnected' } });
    } catch (err) {
      enqueueError = err;
    }

    try {
      await q.reserve();
    } catch (err) {
      reserveError = err;
    }

    expect(enqueueError).not.toBeNull();
    expect(reserveError).not.toBeNull();

    await redis.connect();

    await q.add({
      groupId: 'reconnected-group',
      data: { test: 'reconnected' },
    });
    const job = await q.reserve();
    expect(job).not.toBeNull();
  });
});

describe('损坏的 Redis 数据恢复 (Corrupted Redis Data Recovery)', () => {
  test('应当优雅地处理缺失的任务哈希而不出现连接错误 (should handle missing job hash gracefully without concatenation error)', async ({ redis, createQueue }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const groupId = 'test-group';
    const fakeJobId = 'fake-job-id-12345';

    const gZ = `${queue.namespace}:g:${groupId}`;
    const readyKey = `${queue.namespace}:ready`;

    await redis.zadd(gZ, 1000, fakeJobId);
    await redis.zadd(readyKey, 1000, groupId);

    let errorOccurred = false;
    let concatenationError = false;

    try {
      const result = await queue['reserve']();
      expect(result).toBeNull();
    } catch (error: any) {
      errorOccurred = true;
      if (error.message && error.message.includes('attempt to concatenate')) {
        concatenationError = true;
      }
    }

    expect(concatenationError).toBe(false);

    const validJobId = await queue.add({ groupId, data: { test: 'valid' } });
    expect(validJobId).toBeTruthy();

    const validJob = await queue['reserve']();
    expect(validJob).not.toBeNull();
    expect(typeof validJob?.id).toBe('string');
    expect(validJob?.groupId).toBe(groupId);
  });

  test('应当在 reserveAtomic 中处理缺失的任务哈希 (should handle missing job hash in reserveAtomic)', async ({ redis, createQueue }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const groupId = 'atomic-group';
    const fakeJobId = 'fake-atomic-job';

    const gZ = `${queue.namespace}:g:${groupId}`;
    await redis.zadd(gZ, 1000, fakeJobId);

    const readyKey = `${queue.namespace}:ready`;
    await redis.zadd(readyKey, 1000, groupId);

    let concatenationError = false;

    try {
      const result = await queue['reserveAtomic'](groupId);
      expect(result.status).toBe('empty');
    } catch (error: any) {
      if (error.message && error.message.includes('attempt to concatenate')) {
        concatenationError = true;
      }
    }

    expect(concatenationError).toBe(false);

    await queue.add({ groupId, data: { test: 'valid' } });
    const result = await queue['reserveAtomic'](groupId);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.job.groupId).toBe(groupId);
    }
  });
});
