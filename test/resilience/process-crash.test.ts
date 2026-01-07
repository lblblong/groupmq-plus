import { describe, expect, test, waitUntil } from '../helpers/suite';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';
import { v7 as uuidv7 } from 'uuid';

/**
 * Worker 进程硬崩溃测试
 * 
 * 测试场景：
 * 1. 模拟 Worker 在处理任务中途突然停止（不调用 close，模拟进程崩溃）
 * 2. 验证新 Worker 能否通过 stalledChecker 正确接管并恢复该任务
 * 
 * 关键点：
 * - 使用独立的 Redis 连接来模拟不同的 Worker 进程
 * - 通过直接断开 Redis 连接来模拟进程崩溃
 * - 验证 stalledChecker 能够检测并恢复任务
 */
describe('Worker 进程崩溃恢复 (Worker Process Crash Recovery)', () => {
  test('应当在 Worker 突然停止后恢复任务 (should recover job after worker suddenly stops)', async () => {
    const namespace = `test:crash:${uuidv7()}`;

    // 创建独立的 Redis 连接用于崩溃的 Worker
    const crashingRedis = createRedis();
    const recoveryRedis = createRedis();

    const crashingQueue = new Queue({
      redis: crashingRedis,
      namespace,
      jobTimeoutMs: 2000, // 2 秒超时，便于快速检测 stalled
      keepCompleted: 10,
      keepFailed: 10,
    });

    const recoveryQueue = new Queue({
      redis: recoveryRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    const groupId = 'crash-test-group';
    const jobData = {
      message: 'This job should survive worker crash',
      timestamp: Date.now(),
    };

    // 添加一个任务
    const job = await crashingQueue.add({
      groupId,
      data: jobData,
    });
    const jobId = job.id;

    expect(jobId).toBeTruthy();

    // 创建第一个 Worker，它会在处理任务时"崩溃"
    let processingStarted = false;
    const crashingWorker = new Worker({
      queue: crashingQueue,
      handler: async (job) => {
        processingStarted = true;
        // 模拟长时间运行的任务
        // Worker 会在这里被"杀死"
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return { processed: true };
      },
      // 禁用 stalled checker，让恢复 Worker 来处理
      stalledInterval: 0,
      autoStart: false,
    });

    crashingWorker.run();

    // 等待任务开始处理
    await waitUntil(() => processingStarted, 5000);

    // 验证任务处于 active 状态
    const counts = await recoveryQueue.getJobCounts();
    expect(counts.active).toBe(1);

    // "杀死" Worker - 直接断开 Redis 连接，模拟进程崩溃
    crashingRedis.disconnect();

    // 任务仍然在 active 状态（因为 Worker 崩溃了，没有完成）
    const countsAfterCrash = await recoveryQueue.getJobCounts();
    expect(countsAfterCrash.active).toBe(1);

    // 启动新的 Worker 来恢复任务
    const stalledEvents: Array<{ jobId: string; groupId: string }> = [];
    const completedJobs: Array<{ id: string; data: any }> = [];

    const recoveryWorker = new Worker({
      queue: recoveryQueue,
      handler: async (job) => {
        return { recovered: true, originalData: job.data };
      },
      // 配置 stalled checker 以快速检测和恢复
      stalledInterval: 500, // 每 500ms 检查一次
      maxStalledCount: 2,
      stalledGracePeriod: 0, // 无宽限期
      autoStart: false,
    });

    recoveryWorker.on('stalled', (stalledJobId, stalledGroupId) => {
      stalledEvents.push({ jobId: stalledJobId, groupId: stalledGroupId });
    });

    recoveryWorker.on('completed', (completedJob) => {
      completedJobs.push({ id: completedJob.id, data: completedJob.data });
    });

    recoveryWorker.run();

    // 等待任务被恢复并完成
    await waitUntil(() => completedJobs.length >= 1, 15000);

    // 验证
    expect(stalledEvents.length).toBeGreaterThanOrEqual(1);
    expect(stalledEvents[0].jobId).toBe(jobId);
    expect(stalledEvents[0].groupId).toBe(groupId);

    expect(completedJobs.length).toBe(1);
    expect(completedJobs[0].id).toBe(jobId);
    expect(completedJobs[0].data.message).toBe(jobData.message);

    // 验证队列已清空
    const finalCounts = await recoveryQueue.getJobCounts();
    expect(finalCounts.active).toBe(0);
    expect(finalCounts.waiting).toBe(0);

    // 清理
    await recoveryWorker.close();
    await recoveryQueue.close();

    // 清理 Redis 数据
    const cleanupRedis = createRedis();
    const keys = await cleanupRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.quit();
  }, 30000);

  test('应当在多个任务场景下正确恢复 (should recover multiple jobs correctly)', async () => {
    const namespace = `test:crash-multi:${uuidv7()}`;

    const crashingRedis = createRedis();
    const recoveryRedis = createRedis();

    const crashingQueue = new Queue({
      redis: crashingRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    const recoveryQueue = new Queue({
      redis: recoveryRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    // 添加多个任务到不同的组
    const jobIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await crashingQueue.add({
        groupId: `crash-group-${i}`,
        data: { index: i, message: `Job ${i}` },
      });
      jobIds.push(job.id);
    }

    // 创建第一个 Worker，处理一个任务后"崩溃"
    let processingCount = 0;
    const crashingWorker = new Worker({
      queue: crashingQueue,
      handler: async (job) => {
        processingCount++;
        // 模拟长时间运行的任务
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return { processed: true };
      },
      stalledInterval: 0,
      autoStart: false,
    });

    crashingWorker.run();

    // 等待开始处理
    await waitUntil(() => processingCount >= 1, 5000);

    // "杀死" Worker
    crashingRedis.disconnect();

    // 启动恢复 Worker
    const completedJobIds: string[] = [];
    const stalledJobIds: string[] = [];

    const recoveryWorker = new Worker({
      queue: recoveryQueue,
      handler: async (job) => {
        completedJobIds.push(job.id);
        return { processed: true };
      },
      stalledInterval: 500,
      maxStalledCount: 2,
      stalledGracePeriod: 0,
      autoStart: false,
    });

    recoveryWorker.on('stalled', (stalledJobId) => {
      stalledJobIds.push(stalledJobId);
    });

    recoveryWorker.run();

    // 等待所有任务完成
    await waitUntil(() => completedJobIds.length >= 3, 20000);

    // 验证所有任务都被处理
    expect(completedJobIds.length).toBe(3);
    for (const jobId of jobIds) {
      expect(completedJobIds).toContain(jobId);
    }

    // 至少有一个任务是通过 stalled 恢复的
    expect(stalledJobIds.length).toBeGreaterThanOrEqual(1);

    // 清理
    await recoveryWorker.close();
    await recoveryQueue.close();

    const cleanupRedis = createRedis();
    const keys = await cleanupRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.quit();
  }, 30000);

  test('应当在 Worker 崩溃后保持数据一致性 (should maintain data consistency after worker crash)', async () => {
    const namespace = `test:crash-consistency:${uuidv7()}`;

    const crashingRedis = createRedis();
    const recoveryRedis = createRedis();

    const crashingQueue = new Queue({
      redis: crashingRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    const recoveryQueue = new Queue({
      redis: recoveryRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    const groupId = 'consistency-group';
    const originalData = {
      importantField: 'must-not-be-lost',
      nestedData: { a: 1, b: 2 },
      array: [1, 2, 3],
    };

    const job = await crashingQueue.add({
      groupId,
      data: originalData,
    });
    const jobId = job.id;

    // 创建会崩溃的 Worker
    let processingStarted = false;
    const crashingWorker = new Worker({
      queue: crashingQueue,
      handler: async (job) => {
        processingStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return { processed: true };
      },
      stalledInterval: 0,
      autoStart: false,
    });

    crashingWorker.run();

    await waitUntil(() => processingStarted, 5000);

    // "杀死" Worker
    crashingRedis.disconnect();

    // 验证任务数据在 Redis 中仍然完整
    const storedJob = await recoveryQueue.getJob(jobId);
    expect(storedJob).not.toBeNull();
    expect(storedJob!.data).toEqual(originalData);
    expect(storedJob!.groupId).toBe(groupId);

    // 启动恢复 Worker 并验证数据完整性
    let recoveredData: any = null;

    const recoveryWorker = new Worker({
      queue: recoveryQueue,
      handler: async (job) => {
        recoveredData = job.data;
        return { success: true };
      },
      stalledInterval: 500,
      maxStalledCount: 2,
      stalledGracePeriod: 0,
      autoStart: false,
    });

    recoveryWorker.run();

    await waitUntil(() => recoveredData !== null, 15000);

    // 验证恢复后的数据与原始数据一致
    expect(recoveredData).toEqual(originalData);
    expect(recoveredData.importantField).toBe('must-not-be-lost');
    expect(recoveredData.nestedData).toEqual({ a: 1, b: 2 });
    expect(recoveredData.array).toEqual([1, 2, 3]);

    // 清理
    await recoveryWorker.close();
    await recoveryQueue.close();

    const cleanupRedis = createRedis();
    const keys = await cleanupRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.quit();
  }, 30000);

  test('应当在高并发场景下正确恢复任务 (should recover jobs correctly in high concurrency scenario)', async () => {
    const namespace = `test:crash-concurrent:${uuidv7()}`;

    const crashingRedis = createRedis();
    const recoveryRedis = createRedis();

    const crashingQueue = new Queue({
      redis: crashingRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    const recoveryQueue = new Queue({
      redis: recoveryRedis,
      namespace,
      jobTimeoutMs: 2000,
      keepCompleted: 10,
      keepFailed: 10,
    });

    // 添加多个任务
    const jobIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const job = await crashingQueue.add({
        groupId: `concurrent-crash-group-${i}`,
        data: { index: i },
      });
      jobIds.push(job.id);
    }

    // 创建高并发 Worker，然后崩溃
    let processingCount = 0;
    const crashingWorker = new Worker({
      queue: crashingQueue,
      handler: async (job) => {
        processingCount++;
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return { processed: true };
      },
      concurrency: 5, // 高并发
      stalledInterval: 0,
      autoStart: false,
    });

    crashingWorker.run();

    // 等待一些任务开始处理
    await waitUntil(() => processingCount >= 3, 5000);

    // "杀死" Worker
    crashingRedis.disconnect();

    // 启动恢复 Worker
    const completedJobIds: string[] = [];
    const stalledJobIds: string[] = [];

    const recoveryWorker = new Worker({
      queue: recoveryQueue,
      handler: async (job) => {
        completedJobIds.push(job.id);
        return { processed: true };
      },
      concurrency: 3,
      stalledInterval: 500,
      maxStalledCount: 2,
      stalledGracePeriod: 0,
      autoStart: false,
    });

    recoveryWorker.on('stalled', (stalledJobId) => {
      stalledJobIds.push(stalledJobId);
    });

    recoveryWorker.run();

    // 等待所有任务完成
    await waitUntil(() => completedJobIds.length >= 10, 30000);

    // 验证所有任务都被处理
    expect(completedJobIds.length).toBe(10);
    for (const jobId of jobIds) {
      expect(completedJobIds).toContain(jobId);
    }

    // 应该有一些 stalled 事件（因为崩溃的 Worker 正在处理一些任务）
    expect(stalledJobIds.length).toBeGreaterThanOrEqual(1);

    // 清理
    await recoveryWorker.close();
    await recoveryQueue.close();

    const cleanupRedis = createRedis();
    const keys = await cleanupRedis.keys(`groupmq:${namespace}*`);
    if (keys.length) await cleanupRedis.del(keys);
    await cleanupRedis.quit();
  }, 45000);
});
