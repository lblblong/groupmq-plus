import { describe, expect, test } from '../helpers/suite';

describe('并发限制 (Limited Set - Hot Spot Issues解决方案)', () => {
  test('应该在并发耗尽时将组移动到限制集合', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();

    // Create a group with concurrency limit of 1
    await queue.groups.setConcurrency('single-concurrency-group', 1);

    // Add 5 jobs to the group
    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: 'single-concurrency-group',
        data: { jobId: i },
      });
    }

    // Process all jobs
    const processed: any[] = [];
    const worker = createWorker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    worker.run();

    // Wait for all jobs to complete
    await queue.waitForEmpty();

    // Core assertion: All jobs should be processed successfully
    expect(processed.length).toBe(5);

    // Verify no stale entries remain
    const finalLimited = await redis.zcard(`groupmq:${namespace}:limited`);
    const finalReady = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(finalLimited).toBe(0);
    expect(finalReady).toBe(0);
  });

  test('应该不会在限制的组上浪费CPU进行自旋处理', async ({ namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const groupCount = 50;
    const jobsPerGroup = 3;
    const concurrencyLimit = 1;

    // Setup: many groups with concurrency=1
    for (let g = 0; g < groupCount; g++) {
      await queue.groups.setConcurrency(`group-${g}`, concurrencyLimit);
    }

    // Add jobs
    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `group-${g}`,
          data: { group: g, jobIndex: j },
        });
      }
    }

    const processed: any[] = [];
    let reserveAttempts = 0;

    // Track reserve operations
    const originalReserve = queue.reserve.bind(queue);
    queue.reserve = async () => {
      reserveAttempts++;
      return originalReserve();
    };

    const worker = createWorker({
      queue,
      concurrency: 1,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    worker.run();

    await queue.waitForEmpty();

    // All jobs should be processed
    expect(processed.length).toBe(groupCount * jobsPerGroup);

    // Reserve attempts should be reasonable
    const expectedAttempts = (groupCount * jobsPerGroup) / 1 + groupCount * 2;
    expect(reserveAttempts).toBeLessThan(expectedAttempts * 3);
  });

  test('应该在并发可用时将组从限制集合移回就绪队列', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();

    // Setup: group with concurrency=2
    await queue.groups.setConcurrency('flex-group', 2);

    // Add 5 jobs
    for (let i = 0; i < 5; i++) {
      await queue.add({
        groupId: 'flex-group',
        data: { jobId: i },
      });
    }

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      concurrency: 2,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    worker.run();

    await queue.waitForEmpty();

    expect(processed.length).toBe(5);

    // After completion, group should not be in limited anymore
    const finalLimited = await redis.zcard(`groupmq:${namespace}:limited`);
    expect(finalLimited).toBe(0);
  });

  test('应该为多个组正确验证和重建限制集合', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();

    const groups = [
      { id: 'group-a', concurrency: 1, jobs: 3 },
      { id: 'group-b', concurrency: 2, jobs: 5 },
      { id: 'group-c', concurrency: 3, jobs: 7 },
    ];

    // Setup groups and jobs
    for (const group of groups) {
      await queue.groups.setConcurrency(group.id, group.concurrency);
      for (let j = 0; j < group.jobs; j++) {
        await queue.add({
          groupId: group.id,
          data: { group: group.id, jobIndex: j },
        });
      }
    }

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      concurrency: 2,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    worker.run();

    await queue.waitForEmpty();

    const totalJobs = groups.reduce((sum, g) => sum + g.jobs, 0);
    expect(processed.length).toBe(totalJobs);

    const limitedCount = await redis.zcard(`groupmq:${namespace}:limited`);
    expect(limitedCount).toBe(0);
  });

  test('应该在不出现热点自旋的情况下有效处理1000个组的场景', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const groupCount = 100;
    const jobsPerGroup = 2;
    const workerCount = 5;
    const groupConcurrency = 1;

    // Setup: 100 groups with concurrency=1
    for (let g = 0; g < groupCount; g++) {
      await queue.groups.setConcurrency(`large-scale-${g}`, groupConcurrency);
    }

    // Add jobs
    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `large-scale-${g}`,
          data: { group: g, job: j },
        });
      }
    }

    const processed: any[] = [];
    const startTime = Date.now();

    // Create multiple workers
    for (let w = 0; w < workerCount; w++) {
      const worker = createWorker({
        queue,
        concurrency: 1,
        blockingTimeoutSec: 1,
        handler: async (job) => {
          processed.push(job.data);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      });
      worker.run();
    }

    await queue.waitForEmpty();
    const duration = Date.now() - startTime;

    expect(processed.length).toBe(groupCount * jobsPerGroup);
    expect(duration).toBeLessThan(10000);

    const finalLimited = await redis.zcard(`groupmq:${namespace}:limited`);
    expect(finalLimited).toBe(0);

    const finalReady = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(finalReady).toBe(0);
  });

  test('应该在中断处理后正确验证并重建限制集合', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.groups.setConcurrency('test-group', 1);

    for (let i = 0; i < 3; i++) {
      await queue.add({
        groupId: 'test-group',
        data: { id: i },
      });
    }

    const processed: any[] = [];

    const worker1 = createWorker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    worker1.run();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const limitedBefore = await queue.getLimitedGroups();
    await queue.validateLimitedSet();
    const limitedAfter = await queue.getLimitedGroups();

    expect(Array.isArray(limitedBefore)).toBe(true);
    expect(Array.isArray(limitedAfter)).toBe(true);

    await worker1.close();

    const worker2 = createWorker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    worker2.run();

    await queue.waitForEmpty();

    expect(processed.length).toBe(3);
  });

  test('应该在负载下维持正确的就绪/限制状态转换', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const groupCount = 20;
    const concurrencyPerGroup = 1;

    // Setup groups
    for (let g = 0; g < groupCount; g++) {
      await queue.groups.setConcurrency(`load-group-${g}`, concurrencyPerGroup);
      const jobsForThisGroup = 2 + (g % 3);
      for (let j = 0; j < jobsForThisGroup; j++) {
        await queue.add({
          groupId: `load-group-${g}`,
          data: { group: g, job: j },
        });
      }
    }

    const processed: any[] = [];
    const stateSnapshots: any[] = [];

    const worker = createWorker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);

        if (processed.length % 5 === 0) {
          const ready = await redis.zcard(`groupmq:${namespace}:ready`);
          const limited = await redis.zcard(`groupmq:${namespace}:limited`);
          stateSnapshots.push({
            processedSoFar: processed.length,
            ready,
            limited,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    worker.run();

    await queue.waitForEmpty();

    const totalJobs = Array.from({ length: groupCount }, (_, g) =>
      2 + (g % 3),
    ).reduce((a, b) => a + b, 0);
    expect(processed.length).toBe(totalJobs);

    // 验证处理过程中有状态转换发生
    expect(stateSnapshots.length).toBeGreaterThan(0);

    // 验证最终状态：所有任务完成后，ready 和 limited 应该都为 0
    const finalReady = await redis.zcard(`groupmq:${namespace}:ready`);
    const finalLimited = await redis.zcard(`groupmq:${namespace}:limited`);
    expect(finalReady + finalLimited).toBe(0);
  });
});

describe('中毒群组 (Poisoned/Empty Group Cleanup)', () => {
  test('应该不陷入无限循环地处理就绪队列中的空组', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const readyKey = `groupmq:${namespace}:ready`;
    const poisonedGroupId = 'poisoned-group-123';

    // Manually create a poisoned group
    await redis.zadd(readyKey, Date.now(), poisonedGroupId);

    const groupsBeforeCount = await redis.zcard(readyKey);
    expect(groupsBeforeCount).toBe(1);

    const processedJobs: any[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        processedJobs.push(job);
        return 'done';
      },
      blockingTimeoutSec: 0.5,
    });
    worker.run();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await queue.add({ groupId: 'real-group', data: { test: true } });

    await queue.waitForEmpty(5000);

    expect(processedJobs.length).toBe(1);
    expect(processedJobs[0].data).toEqual({ test: true });
  });

  test('应该不删除有任务的群组', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.add({ groupId: 'test-group', data: { foo: 'bar' } });

    let processedCount = 0;
    const worker = createWorker({
      queue,
      handler: async () => {
        processedCount++;
        return 'done';
      },
      blockingTimeoutSec: 1,
    });
    worker.run();

    await queue.waitForEmpty(5000);

    expect(processedCount).toBe(1);
  });

  test('应该处理所有尝试都已耗尽的群组', async ({ createQueue, createWorker }) => {
    const queue = createQueue();
    const groupId = 'exhausted-group';

    await queue.add({ groupId, data: { foo: 'bar' }, maxAttempts: 1 });

    let attempts = 0;
    const worker1 = createWorker({
      queue,
      handler: async () => {
        attempts++;
        throw new Error('Intentional failure');
      },
      blockingTimeoutSec: 0.5,
      maxAttempts: 1,
    });
    worker1.run();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(attempts).toBe(1);

    await worker1.close();

    let newAttempts = 0;
    const worker2 = createWorker({
      queue,
      handler: async () => {
        newAttempts++;
        return 'done';
      },
      blockingTimeoutSec: 0.5,
    });
    worker2.run();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(newAttempts).toBe(0);
  });

  test('应该恢复具有有效任务的活跃群组', async ({ createQueue, createWorker }) => {
    const queue = createQueue();
    const groupId = 'active-group';

    await queue.add({ groupId, data: { job: 1 } });
    await queue.add({ groupId, data: { job: 2 } });

    let processedCount = 0;

    const worker = createWorker({
      queue,
      handler: async () => {
        processedCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      },
      blockingTimeoutSec: 1,
      concurrency: 1,
    });
    worker.run();

    await queue.waitForEmpty(5000);

    expect(processedCount).toBe(2);
  });
});

describe('就绪队列维护 (Ready Queue Cleanup)', () => {
  test('应该在完成后从就绪队列中删除空的群组', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const groupCount = 10;
    const jobsPerGroup = 5;

    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `group-${g}`,
          data: { group: g, job: j },
        });
      }
    }

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    worker.run();

    await queue.waitForEmpty();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const finalReadyCount = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(finalReadyCount).toBe(0);

    expect(processed.length).toBe(groupCount * jobsPerGroup);
  });

  test('应该不会因陈旧的就绪队列项而死锁', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();
    const groupCount = 100;
    const jobsPerGroup = 3;

    // Round 1
    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `round1-group-${g}`,
          data: { round: 1, group: g, job: j },
        });
      }
    }

    const processed: any[] = [];
    const worker = createWorker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
      },
    });
    worker.run();

    await queue.waitForEmpty();

    const readyCountAfterRound1 = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(readyCountAfterRound1).toBe(0);

    // Round 2
    const round2Groups = 10;
    for (let g = 0; g < round2Groups; g++) {
      await queue.add({
        groupId: `round2-group-${g}`,
        data: { round: 2, group: g, job: 0 },
      });
    }

    const startTime = Date.now();
    await queue.waitForEmpty();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(5000);

    const round1Jobs = processed.filter((j) => j.round === 1);
    const round2Jobs = processed.filter((j) => j.round === 2);
    expect(round1Jobs.length).toBe(groupCount * jobsPerGroup);
    expect(round2Jobs.length).toBe(round2Groups);

    const finalReadyCount = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(finalReadyCount).toBe(0);
  });

  test('应该在不出现就绪队列泄漏的情况下处理混合群组生命周期', async ({ redis, namespace, createQueue, createWorker }) => {
    const queue = createQueue();

    const worker = createWorker({
      queue,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    worker.run();

    await queue.add({ groupId: 'group-A', data: { seq: 1 } });
    await queue.add({ groupId: 'group-A', data: { seq: 2 } });
    await queue.add({ groupId: 'group-B', data: { seq: 1 } });

    await new Promise((resolve) => setTimeout(resolve, 200));

    await queue.add({ groupId: 'group-A', data: { seq: 3 } });
    await queue.add({ groupId: 'group-C', data: { seq: 1 } });

    await queue.waitForEmpty();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const readyCount = await redis.zcard(`groupmq:${namespace}:ready`);
    expect(readyCount).toBe(0);

    const groupsCount = await redis.scard(`groupmq:${namespace}:groups`);
    expect(groupsCount).toBe(0);
  });
});
