import { describe, expect, test, waitUntil } from '../helpers/suite';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';
import { v7 as uuidv7 } from 'uuid';

/**
 * BullMQ 风格独立锁测试
 * 
 * 测试场景：
 * 1. 验证独立锁 Key 在 TTL 后自动过期
 * 2. 验证新 Worker 启动时能立即检测到无锁任务
 */
describe('BullMQ 风格秒级恢复 (BullMQ-style Instant Recovery)', () => {
  test('独立锁 Key 应该在 TTL 后自动过期', async () => {
    const namespace = `test:lock-expiry:${uuidv7()}`;

    const redis1 = createRedis();
    const redis2 = createRedis();

    const queue = new Queue({
      redis: redis1,
      namespace,
      jobTimeoutMs: 2000, // 2 秒锁过期
    });

    // 添加任务
    await queue.add({ groupId: 'g1', data: { id: 'lock-test' } });

    // Worker 取走任务
    let processingStarted = false;
    const worker = new Worker({
      queue,
      handler: async () => {
        processingStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 60000));
      },
      stalledInterval: 0, // 禁用 stalled checker
      autoStart: false,
    });

    worker.run();
    await waitUntil(() => processingStarted, 5000);

    // 检查锁是否存在
    const lockKeys = await redis2.keys(`groupmq:${namespace}:lock:*`);
    expect(lockKeys.length).toBe(1);

    // 强制断开连接（模拟崩溃）
    redis1.disconnect();

    // 锁应该还在（还没过期）
    const lockKeysAfterCrash = await redis2.keys(`groupmq:${namespace}:lock:*`);
    expect(lockKeysAfterCrash.length).toBe(1);

    // 等待锁过期（2 秒 + 缓冲）
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 锁应该已经自动过期消失
    const lockKeysAfterExpiry = await redis2.keys(`groupmq:${namespace}:lock:*`);
    expect(lockKeysAfterExpiry.length).toBe(0);

    // 清理
    const keys = await redis2.keys(`groupmq:${namespace}*`);
    if (keys.length) await redis2.del(keys);
    await redis2.quit();
  }, 15000);

  test('新 Worker 启动时应立即检测到无锁任务并恢复', async () => {
    const namespace = `test:instant-recovery:${uuidv7()}`;

    const crashingRedis = createRedis();
    const recoveryRedis = createRedis();

    const crashingQueue = new Queue({
      redis: crashingRedis,
      namespace,
      jobTimeoutMs: 2000, // 2 秒锁过期
    });

    const recoveryQueue = new Queue({
      redis: recoveryRedis,
      namespace,
      jobTimeoutMs: 2000,
    });

    // 添加任务
    const job = await crashingQueue.add({ groupId: 'g1', data: { id: 'recovery-test' } });
    const jobId = job.id;

    // Worker 1 取走任务然后崩溃
    let processingStarted = false;
    const crashingWorker = new Worker({
      queue: crashingQueue,
      handler: async () => {
        processingStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 60000));
      },
      stalledInterval: 0,
      autoStart: false,
    });

    crashingWorker.run();
    await waitUntil(() => processingStarted, 5000);

    const crashTime = Date.now();
    crashingRedis.disconnect();

    // 等待锁过期
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Worker 2 启动，应该立即检测到并恢复任务
    let recoveryTime = 0;
    const stalledEvents: string[] = [];
    const completedJobs: string[] = [];

    const recoveryWorker = new Worker({
      queue: recoveryQueue,
      stalledInterval: 500, // 500ms 检查一次
      handler: async (job) => {
        recoveryTime = Date.now() - crashTime;
        completedJobs.push(job.id);
      },
      autoStart: false,
    });

    recoveryWorker.on('stalled', (stalledJobId) => {
      stalledEvents.push(stalledJobId);
    });

    recoveryWorker.run();

    // 等待任务被处理
    await waitUntil(() => completedJobs.length >= 1, 10000);

    // 验证
    expect(stalledEvents).toContain(jobId);
    expect(completedJobs).toContain(jobId);

    // 验证恢复时间：锁过期(2s) + 检测(~0.5s) ≈ 2.5-4s
    expect(recoveryTime).toBeGreaterThan(2000);
    expect(recoveryTime).toBeLessThan(6000);

    // 清理
    await recoveryWorker.close();
    await recoveryQueue.close();

    const cleanupRedis = createRedis();
    const keys = await cleanupRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.quit();
  }, 20000);

  test('心跳应该续期独立锁，防止长任务被误判', async () => {
    const namespace = `test:heartbeat-lock:${uuidv7()}`;

    const redis = createRedis();
    const checkRedis = createRedis();

    const queue = new Queue({
      redis,
      namespace,
      jobTimeoutMs: 2000, // 2 秒锁过期
    });

    // 添加任务
    await queue.add({ groupId: 'g1', data: { id: 'heartbeat-test' } });

    // Worker 处理长任务（超过锁 TTL）
    let taskCompleted = false;
    let lockChecks = 0;

    const worker = new Worker({
      queue,
      heartbeatMs: 500, // 500ms 心跳
      handler: async () => {
        // 模拟 5 秒任务（超过 2 秒锁 TTL）
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          // 检查锁是否还在
          const lockKeys = await checkRedis.keys(`groupmq:${namespace}:lock:*`);
          if (lockKeys.length > 0) {
            lockChecks++;
          }
        }
        taskCompleted = true;
      },
      stalledInterval: 0,
      autoStart: false,
    });

    worker.run();

    // 等待任务完成
    await waitUntil(() => taskCompleted, 15000);

    // 心跳应该保持锁活跃（任务执行 5 秒，锁 TTL 2 秒，心跳应该续期多次）
    expect(lockChecks).toBeGreaterThan(5);

    // 清理
    await worker.close();
    await queue.close();

    const keys = await checkRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await checkRedis.del(keys);
    await checkRedis.quit();
  }, 20000);
});
