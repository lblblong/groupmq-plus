import { describe, expect, test } from '../helpers/suite';
import { UnrecoverableError } from '../../src';

describe('重试行为测试 (Retry Behavior Tests)', () => {
  test('应当尊重 maxAttempts 并移动到死信队列 (should respect maxAttempts and move to dead letter queue)', async ({ createQueue, createWorker }) => {
    const q = createQueue({
      maxAttempts: 3,
    });

    const _jobId = await q.add({
      groupId: 'fail-group',
      data: { shouldFail: true },
      maxAttempts: 2,
    });

    let attemptCount = 0;
    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 0.1,
      schedulerIntervalMs: 50,
      backoff: () => 10,
      maxAttempts: 2,
      handler: async (_job) => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount} failed`);
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(attemptCount).toBe(2);

    const job = await q.reserve();
    expect(job).toBeNull();
  });

  test('应当正确使用指数退避 (should use exponential backoff correctly)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    await q.add({
      groupId: 'backoff-group',
      data: { test: 'backoff' },
      maxAttempts: 3,
    });

    const attempts: number[] = [];
    let failCount = 0;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 5,
      maxAttempts: 3,
      backoff: (attempt) => attempt * 100,
      handler: async (_job) => {
        attempts.push(Date.now());
        failCount++;
        if (failCount < 3) {
          throw new Error(`Fail ${failCount}`);
        }
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(attempts.length).toBe(3);

    if (attempts.length >= 2) {
      const delay1 = attempts[1] - attempts[0];
      expect(delay1).toBeGreaterThan(80);
    }

    if (attempts.length >= 3) {
      const delay2 = attempts[2] - attempts[1];
      expect(delay2).toBeGreaterThan(180);
    }
  });

  test('应当处理同一组中的混合成功/失败 (should handle mixed success/failure in same group)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    await q.add({
      groupId: 'mixed-group',
      data: { id: 1, shouldFail: false },
      orderMs: 1,
    });
    await q.add({
      groupId: 'mixed-group',
      data: { id: 2, shouldFail: true },
      orderMs: 2,
    });
    await q.add({
      groupId: 'mixed-group',
      data: { id: 3, shouldFail: false },
      orderMs: 3,
    });

    const processed: number[] = [];
    let failureCount = 0;

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 5,
      maxAttempts: 3,
      backoff: () => 50,
      handler: async (job) => {
        if (job.data.shouldFail && failureCount === 0) {
          failureCount++;
          throw new Error('Intentional failure');
        }
        processed.push(job.data.id);
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(processed).toEqual([1, 2, 3]);
  });

  test('应当处理不同错误类型的重试 (should handle retry with different error types)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    await q.add({ groupId: 'error-group', data: { errorType: 'timeout' } });
    await q.add({ groupId: 'error-group', data: { errorType: 'network' } });
    await q.add({ groupId: 'error-group', data: { errorType: 'parse' } });

    const errors: string[] = [];
    const processed: string[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 5,
      maxAttempts: 2,
      backoff: () => 10,
      handler: async (job) => {
        const { errorType } = job.data;
        const errorKey = `${errorType}-failed`;
        if (!processed.find((e) => e === errorKey)) {
          processed.push(errorKey);
          switch (errorType) {
            case 'timeout':
              throw new Error('Request timeout');
            case 'network':
              throw new Error('Network error');
            case 'parse':
              throw new Error('Parse error');
          }
        }
        processed.push(errorType);
      },
      onError: (err, job) => {
        errors.push(`${job?.data.errorType}: ${(err as Error).message}`);
      },
    });

    worker.run();

    await q.waitForEmpty();

    const actualProcessed = processed.filter(
      (item) => !item.includes('-failed'),
    );
    expect(actualProcessed).toEqual(['timeout', 'network', 'parse']);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('timeout: Request timeout');
    expect(errors[1]).toContain('network: Network error');
    expect(errors[2]).toContain('parse: Parse error');
  });

  test('应当在具有多个组的重试期间维持 FIFO 顺序 (should maintain FIFO order during retries with multiple groups)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    await q.add({
      groupId: 'group-A',
      data: { id: 'A1', fail: true },
      orderMs: 1,
    });
    await q.add({
      groupId: 'group-B',
      data: { id: 'B1', fail: false },
      orderMs: 2,
    });
    await q.add({
      groupId: 'group-A',
      data: { id: 'A2', fail: false },
      orderMs: 3,
    });
    await q.add({
      groupId: 'group-B',
      data: { id: 'B2', fail: true },
      orderMs: 4,
    });

    const processed: string[] = [];
    const failedIds = new Set<string>();

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 5,
      maxAttempts: 3,
      backoff: () => 20,
      handler: async (job) => {
        const { id, fail } = job.data;
        if (fail && !failedIds.has(id)) {
          failedIds.add(id);
          throw new Error(`${id} failed`);
        }
        processed.push(id);
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(processed).toContain('A1');
    expect(processed).toContain('A2');
    expect(processed).toContain('B1');
    expect(processed).toContain('B2');

    const groupAOrder = processed.filter((id) => id.startsWith('A'));
    const groupBOrder = processed.filter((id) => id.startsWith('B'));

    expect(groupAOrder).toEqual(['A1', 'A2']);
    expect(groupBOrder).toEqual(['B1', 'B2']);
  });

  test('应当在抛出 UnrecoverableError 时立即失败 (should immediately fail when UnrecoverableError is thrown)', async ({ createQueue, createWorker }) => {
    const q = createQueue({
      maxAttempts: 5,
      keepFailed: 1,
    });

    await q.add({
      groupId: 'fatal-group',
      data: { fatal: true },
    });

    let attemptCount = 0;
    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      handler: async () => {
        attemptCount++;
        throw new UnrecoverableError('This job is broken');
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(attemptCount).toBe(1);

    const failedJobs = await q.getFailed();
    expect(failedJobs.length).toBe(1);
    expect(failedJobs[0].failedReason).toBe('This job is broken');
  });

  test('应当支持基于错误类型的智能退避 (should support smart backoff based on error type)', async ({ createQueue, createWorker }) => {
    const q = createQueue();

    class RateLimitError extends Error {
      retryAfterMs: number;
      constructor(retryAfterMs: number) {
        super('Rate Limited');
        this.retryAfterMs = retryAfterMs;
      }
    }

    await q.add({
      groupId: 'smart-group',
      data: { type: 'rate-limit' },
      maxAttempts: 2,
    });

    const attemptTimestamps: number[] = [];

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 1,
      backoff: (attempt, err) => {
        if (err instanceof RateLimitError) {
          return err.retryAfterMs;
        }
        return 100;
      },
      handler: async () => {
        attemptTimestamps.push(Date.now());
        if (attemptTimestamps.length === 1) {
          throw new RateLimitError(500);
        }
        return 'success';
      },
    });

    worker.run();

    await q.waitForEmpty();

    expect(attemptTimestamps.length).toBe(2);
    const delay = attemptTimestamps[1] - attemptTimestamps[0];
    expect(delay).toBeGreaterThanOrEqual(450);
    expect(delay).toBeLessThan(1500);
  });
});
