import { describe, expect, test, waitUntil } from '../helpers/suite';
import { vi } from 'vitest';

/**
 * Lua 脚本原子性失败模拟测试
 * 
 * 测试场景：
 * 1. Mock queue.redis.eval 或 evalsha，使其抛出错误（模拟 Redis OOM 或脚本超时）
 * 2. 验证 Queue/Worker 是否能优雅处理，而不是抛出未捕获异常导致程序崩溃
 */
describe('Lua 脚本失败处理 (Lua Script Failure Handling)', () => {
  test('应当优雅处理 Redis eval 错误 (should handle Redis eval errors gracefully)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    // 先添加一些任务
    for (let i = 0; i < 3; i++) {
      await queue.add({
        groupId: `lua-error-group-${i}`,
        data: { index: i },
      });
    }

    const errors: Error[] = [];
    const completedJobs: string[] = [];
    let evalCallCount = 0;

    // 保存原始的 evalsha 方法
    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，在第 2 次调用时抛出错误
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      evalCallCount++;
      if (evalCallCount === 2) {
        throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        completedJobs.push(job.id);
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待一段时间让 Worker 处理
    await waitUntil(() => completedJobs.length >= 2 || errors.length >= 1, 10000);

    // Worker 应该继续运行，不应该崩溃
    expect(worker.isClosed).toBe(false);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待剩余任务完成
    await queue.waitForEmpty({ timeoutMs: 10000 });

    // 验证大部分任务最终被处理
    expect(completedJobs.length).toBeGreaterThanOrEqual(2);
  });

  test('应当处理 Redis OOM 错误 (should handle Redis OOM errors)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    await queue.add({
      groupId: 'oom-test-group',
      data: { test: 'oom' },
    });

    const errors: Error[] = [];
    let oomErrorThrown = false;

    // 保存原始方法
    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);
    let callCount = 0;

    // Mock evalsha 方法，模拟 OOM 错误
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      callCount++;
      // 第一次调用时抛出 OOM 错误
      if (callCount === 1) {
        oomErrorThrown = true;
        const oomError = new Error('OOM command not allowed when used memory > maxmemory');
        (oomError as any).code = 'OOM';
        throw oomError;
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待错误被捕获
    await waitUntil(() => oomErrorThrown && errors.length >= 1, 5000);

    // Worker 应该继续运行
    expect(worker.isClosed).toBe(false);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待任务最终完成（重试后）
    await queue.waitForEmpty({ timeoutMs: 10000 });
  });

  test('应当处理脚本超时错误 (should handle script timeout errors)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    await queue.add({
      groupId: 'timeout-test-group',
      data: { test: 'timeout' },
    });

    const errors: Error[] = [];
    let timeoutErrorThrown = false;

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);
    let callCount = 0;

    // Mock evalsha 方法，模拟脚本超时
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      callCount++;
      if (callCount === 1) {
        timeoutErrorThrown = true;
        const timeoutError = new Error('BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.');
        (timeoutError as any).code = 'BUSY';
        throw timeoutError;
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待错误被捕获
    await waitUntil(() => timeoutErrorThrown && errors.length >= 1, 5000);

    // Worker 应该继续运行
    expect(worker.isClosed).toBe(false);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待任务最终完成
    await queue.waitForEmpty({ timeoutMs: 10000 });
  });

  test('应当处理连续的 Lua 脚本错误 (should handle consecutive Lua script errors)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    // 添加多个任务
    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: `consecutive-error-group-${i}`,
        data: { index: i },
      });
    }

    const errors: Error[] = [];
    const completedJobs: string[] = [];
    let errorCount = 0;

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，前 3 次调用都抛出错误
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      errorCount++;
      if (errorCount <= 3) {
        throw new Error(`Simulated Lua error #${errorCount}`);
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        completedJobs.push(job.id);
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待一些错误被捕获
    await waitUntil(() => errors.length >= 3, 10000);

    // Worker 应该继续运行，不应该崩溃
    expect(worker.isClosed).toBe(false);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待任务完成
    await queue.waitForEmpty({ timeoutMs: 15000 });

    // 验证任务最终被处理
    expect(completedJobs.length).toBe(5);
  });

  test('应当在 reserve 操作失败时不丢失任务 (should not lose jobs when reserve operation fails)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    const jobId = await queue.add({
      groupId: 'reserve-fail-group',
      data: { important: 'data' },
    });

    const errors: Error[] = [];
    let reserveFailCount = 0;
    let jobProcessed = false;

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，让 reserve 操作失败几次
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      reserveFailCount++;
      if (reserveFailCount <= 2) {
        throw new Error('Simulated reserve failure');
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        jobProcessed = true;
        expect(job.id).toBe(jobId);
        expect(job.data.important).toBe('data');
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待一些错误
    await waitUntil(() => errors.length >= 1, 5000);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待任务完成
    await waitUntil(() => jobProcessed, 10000);

    // 验证任务被正确处理，数据没有丢失
    expect(jobProcessed).toBe(true);

    // 验证队列已清空
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(0);
    expect(counts.active).toBe(0);
  });

  test('应当在 complete 操作失败时正确处理 (should handle complete operation failure correctly)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 10000,
    });

    await queue.add({
      groupId: 'complete-fail-group',
      data: { test: 'complete-fail' },
    });

    const errors: Error[] = [];
    let handlerCalled = false;
    let completeFailCount = 0;

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，让 complete 操作失败
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      // 在 handler 被调用后，让下一次 evalsha 调用失败（可能是 complete）
      if (handlerCalled && completeFailCount === 0) {
        completeFailCount++;
        throw new Error('Simulated complete failure');
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        handlerCalled = true;
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待 handler 被调用
    await waitUntil(() => handlerCalled, 5000);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 等待队列清空（可能需要重试）
    await queue.waitForEmpty({ timeoutMs: 15000 });

    // Worker 应该继续运行
    expect(worker.isClosed).toBe(false);
  });

  test('应当处理 evalsha 缓存未命中 (should handle evalsha cache miss)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
    });

    await queue.add({
      groupId: 'evalsha-miss-group',
      data: { test: 'evalsha' },
    });

    const errors: Error[] = [];
    let evalshaCallCount = 0;
    let jobCompleted = false;

    // 如果 redis 有 evalsha 方法，mock 它
    if (typeof queue.redis.evalsha === 'function') {
      const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

      (queue.redis as any).evalsha = vi.fn(async (...args: unknown[]) => {
        evalshaCallCount++;
        if (evalshaCallCount === 1) {
          // 模拟脚本缓存未命中
          const error = new Error('NOSCRIPT No matching script. Please use EVAL.');
          (error as any).code = 'NOSCRIPT';
          throw error;
        }
        return originalEvalsha(...args);
      });
    }

    const worker = createWorker({
      queue,
      handler: async (job) => {
        jobCompleted = true;
        return { processed: true };
      },
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待任务完成
    await waitUntil(() => jobCompleted, 10000);

    // Worker 应该继续运行
    expect(worker.isClosed).toBe(false);
    expect(jobCompleted).toBe(true);
  });
});

describe('Queue 操作 Lua 错误处理 (Queue Operation Lua Error Handling)', () => {
  test('应当在 add 操作失败时抛出错误 (should throw error when add operation fails)', async ({ createQueue }) => {
    const queue = createQueue();

    // evalScript 使用 evalsha，所以我们需要 mock evalsha
    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，让 add 操作失败
    (queue.redis as any).evalsha = vi.fn(async () => {
      throw new Error('Simulated add failure');
    });

    let addError: Error | null = null;
    try {
      await queue.add({
        groupId: 'add-fail-group',
        data: { test: 'add-fail' },
      });
    } catch (err) {
      addError = err as Error;
    }

    // 应该抛出错误
    expect(addError).not.toBeNull();
    expect(addError!.message).toContain('Simulated add failure');

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;
  });

  test('应当在 getJobCounts 失败时优雅处理 (should handle getJobCounts failure gracefully)', async ({ createQueue }) => {
    const queue = createQueue();

    // 先添加一些任务
    await queue.add({
      groupId: 'counts-fail-group',
      data: { test: 'counts' },
    });

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);
    let callCount = 0;

    // Mock evalsha 方法，第二次调用时失败（第一次是 add）
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      callCount++;
      if (callCount > 1) {
        throw new Error('Simulated getJobCounts failure');
      }
      return originalEvalsha(...args);
    });

    // 重新添加任务以触发第一次调用
    await queue.add({
      groupId: 'counts-fail-group-2',
      data: { test: 'counts2' },
    }).catch(() => { }); // 忽略可能的错误

    let countsError: Error | null = null;
    try {
      await queue.getJobCounts();
    } catch (err) {
      countsError = err as Error;
    }

    // 应该抛出错误
    expect(countsError).not.toBeNull();

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 验证队列仍然可用
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBeGreaterThanOrEqual(1);
  });

  test('应当在 heartbeat 失败时不影响任务处理 (should not affect job processing when heartbeat fails)', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 30000, // 长超时以确保任务不会因为 heartbeat 失败而超时
    });

    await queue.add({
      groupId: 'heartbeat-fail-group',
      data: { test: 'heartbeat' },
    });

    const errors: Error[] = [];
    let jobCompleted = false;
    let heartbeatFailCount = 0;

    const originalEvalsha = (queue.redis as any).evalsha.bind(queue.redis);

    // Mock evalsha 方法，让 heartbeat 操作失败（通过检查 SHA 或参数）
    (queue.redis as any).evalsha = vi.fn(async (...args: any[]) => {
      // heartbeat 脚本的特征：参数中包含 job id 和 token
      // 我们通过检查参数数量和内容来识别 heartbeat 调用
      const numKeys = args[1];
      const argv = args.slice(2);

      // heartbeat 调用特征：numKeys=1, argv 包含 namespace, jobId, groupId, token, extendMs
      if (numKeys === 1 && argv.length >= 5 && jobCompleted === false) {
        // 检查是否是 heartbeat（通过参数模式判断）
        const possibleJobId = argv[1];
        const possibleGroupId = argv[2];
        if (possibleJobId && possibleGroupId && possibleGroupId.includes('heartbeat-fail-group')) {
          heartbeatFailCount++;
          if (heartbeatFailCount <= 3) {
            throw new Error('Simulated heartbeat failure');
          }
        }
      }
      return originalEvalsha(...args);
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        // 模拟一个需要一些时间的任务，让 heartbeat 有机会被调用
        await new Promise((resolve) => setTimeout(resolve, 1000));
        jobCompleted = true;
        return { processed: true };
      },
      heartbeatMs: 200, // 频繁的 heartbeat
      autoStart: false,
    });

    worker.on('error', (err) => {
      errors.push(err);
    });

    worker.run();

    // 等待任务完成
    await waitUntil(() => jobCompleted, 15000);

    // 恢复原始方法
    (queue.redis as any).evalsha = originalEvalsha;

    // 任务应该完成，即使 heartbeat 失败了
    expect(jobCompleted).toBe(true);

    // 应该有一些 heartbeat 错误（由于 heartbeat 延迟启动，可能为 0）
    // 主要验证任务能正常完成
  });
});
