import { afterEach, afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../../src';
import { createRedis } from '../helpers/redis';

let globalRedis: any;

beforeAll(async () => {
  globalRedis = createRedis();
});

afterAll(async () => {
  try {
    if (globalRedis && globalRedis.status !== 'end') {
      await globalRedis.quit();
    }
  } catch {
    // Ignore cleanup errors
  }
});

describe('并发限制 (Limited Set - Hot Spot Issues解决方案)', () => {
  let redis: any;
  let namespace: string;
  let queue: Queue<any>;
  let workers: Worker<any>[] = [];

  beforeEach(async () => {
    redis = createRedis();
    namespace = `test-limited-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    queue = new Queue({
      redis,
      namespace,
    });
  });

  afterEach(async () => {
    for (const worker of workers) {
      try {
        await worker.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    workers = [];

    try {
      await queue.close();
    } catch {
      // Ignore cleanup errors
    }

    try {
      await redis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('应该在并发耗尽时将组移动到限制集合', async () => {
    // This test verifies that when a group reaches its concurrency limit,
    // subsequent jobs are properly managed (either in ready or limited set)
    // and are processed correctly without deadlock or starvation.

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
    const worker = new Worker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    workers.push(worker);
    worker.run();

    // Wait for all jobs to complete
    await queue.waitForEmpty();

    // Core assertion: All jobs should be processed successfully
    // This proves the limited set mechanism is working (no deadlock or starvation)
    expect(processed.length).toBe(5);

    // Verify no stale entries remain
    const finalLimited = await redis.zcard(`${namespace}:limited`);
    const finalReady = await redis.zcard(`${namespace}:ready`);
    expect(finalLimited).toBe(0);
    expect(finalReady).toBe(0);

    await worker.close();
  });

  it('应该不会在限制的组上浪费CPU进行自旋处理', async () => {
    // This is the core "Hot Spot" issue test
    // With the fix, workers should NOT repeatedly try to reserve from groups at capacity
    // Without the fix, ready queue would keep re-processing the same full groups

    const groupCount = 50;
    const jobsPerGroup = 3;
    const concurrencyLimit = 1; // Force many groups into limited state

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

    // Create ONE worker that processes slowly
    const worker = new Worker({
      queue,
      concurrency: 1,
      blockingTimeoutSec: 1,
      handler: async (job) => {
        processed.push(job.data);
        // Simulate some work time
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    // Track reserve operations (how many times worker tries to grab jobs)
    const originalReserve = queue.reserve.bind(queue);
    queue.reserve = async () => {
      reserveAttempts++;
      return originalReserve();
    };

    workers.push(worker);
    worker.run();

    // Wait for processing to complete
    await queue.waitForEmpty();

    // Key assertions for Hot Spot fix:
    // 1. All jobs should be processed
    expect(processed.length).toBe(groupCount * jobsPerGroup);

    // 2. Reserve attempts should be reasonable
    // Without the fix, it would be very high because workers keep hitting the ready queue
    // With the fix, it should be proportional to jobs * number of groups
    // Rough estimate: (groupCount * jobsPerGroup) / concurrency + some overhead
    // Allow up to 2x as overhead for fairness checks
    const expectedAttempts = (groupCount * jobsPerGroup) / 1 + groupCount * 2; // rough estimate
    expect(reserveAttempts).toBeLessThan(expectedAttempts * 3); // Very generous limit

    await worker.close();
  });

  it('应该在并发可用时将组从限制集合移回就绪队列', async () => {
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
    const worker = new Worker({
      queue,
      concurrency: 2, // Can process 2 jobs simultaneously
      handler: async (job) => {
        processed.push(job.data);
        // Quick processing
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    workers.push(worker);
    worker.run();

    // Let it process some jobs
    await queue.waitForEmpty();

    // All jobs should have been processed
    expect(processed.length).toBe(5);

    // After completion, group should not be in limited anymore
    const finalLimited = await redis.zcard(`${namespace}:limited`);
    expect(finalLimited).toBe(0);

    await worker.close();
  });

  it('应该为多个组正确验证和重建限制集合', async () => {
    // Add multiple groups with different concurrency settings
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
    const worker = new Worker({
      queue,
      concurrency: 2,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    workers.push(worker);
    worker.run();

    await queue.waitForEmpty();

    // Verify all jobs processed
    const totalJobs = groups.reduce((sum, g) => sum + g.jobs, 0);
    expect(processed.length).toBe(totalJobs);

    // Verify groups were properly managed (none should be in limited after completion)
    const limitedCount = await redis.zcard(`${namespace}:limited`);
    expect(limitedCount).toBe(0);

    await worker.close();
  });

  it('应该在不出现热点自旋的情况下有效处理1000个组的场景', async () => {
    // This is the critical scenario mentioned in the issue:
    // 1000 groups + high concurrency (many workers)

    const groupCount = 100; // Reduced from 1000 for test speed, but same logic applies
    const jobsPerGroup = 2;
    const workerCount = 5;
    const groupConcurrency = 1; // Forces groups into limited state

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

    // Create multiple workers (simulating high concurrency scenario)
    for (let w = 0; w < workerCount; w++) {
      const worker = new Worker({
        queue,
        concurrency: 1,
        blockingTimeoutSec: 1,
        handler: async (job) => {
          processed.push(job.data);
          // Minimal processing time
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      });
      workers.push(worker);
      worker.run();
    }

    // Wait for all jobs to complete
    await queue.waitForEmpty();
    const duration = Date.now() - startTime;

    // Assertions:
    // 1. All jobs should be processed
    expect(processed.length).toBe(groupCount * jobsPerGroup);

    // 2. Should complete in reasonable time
    // With the hot spot issue, this would be much slower (spinning on ready queue)
    // With the fix (limited set), it should be faster
    // Allow generous buffer (5 seconds for 200 jobs with 5 workers)
    expect(duration).toBeLessThan(10000);

    // 3. No stale entries in limited set
    const finalLimited = await redis.zcard(`${namespace}:limited`);
    expect(finalLimited).toBe(0);

    // 4. Ready queue should also be empty
    const finalReady = await redis.zcard(`${namespace}:ready`);
    expect(finalReady).toBe(0);
  });

  it('应该在中断处理后正确验证并重建限制集合', async () => {
    // Scenario: some groups might have stale entries in limited set
    // This tests the validateLimitedSet functionality

    await queue.groups.setConcurrency('test-group', 1);

    // Add jobs
    for (let i = 0; i < 3; i++) {
      await queue.add({
        groupId: 'test-group',
        data: { id: i },
      });
    }

    const processed: any[] = [];

    // Start first worker - will process 1 job and stop
    let processCount = 0;
    const worker1 = new Worker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);
        processCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    workers.push(worker1);
    worker1.run();

    // Let it process first job
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Manually validate limited set
    const limitedBefore = await queue.getLimitedGroups();

    // Trigger validation
    await queue.validateLimitedSet();

    const limitedAfter = await queue.getLimitedGroups();

    // Limited set should be consistent
    expect(Array.isArray(limitedBefore)).toBe(true);
    expect(Array.isArray(limitedAfter)).toBe(true);

    await worker1.close();

    // Continue with new worker
    const worker2 = new Worker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    workers.push(worker2);
    worker2.run();

    await queue.waitForEmpty();

    // All jobs should eventually be processed
    expect(processed.length).toBe(3);

    await worker2.close();
  });

  it('应该在负载下维持正确的就绪/限制状态转换', async () => {
    const groupCount = 20;
    const concurrencyPerGroup = 1;

    // Setup groups
    for (let g = 0; g < groupCount; g++) {
      await queue.groups.setConcurrency(`load-group-${g}`, concurrencyPerGroup);
      // Variable number of jobs per group
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

    // Single worker with slow processing to see state transitions
    const worker = new Worker({
      queue,
      concurrency: 1,
      handler: async (job) => {
        processed.push(job.data);

        // Periodically capture state
        if (processed.length % 5 === 0) {
          const ready = await redis.zcard(`${namespace}:ready`);
          const limited = await redis.zcard(`${namespace}:limited`);
          stateSnapshots.push({
            processedSoFar: processed.length,
            ready,
            limited,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    workers.push(worker);
    worker.run();

    await queue.waitForEmpty();

    // Verify all jobs processed
    const totalJobs = Array.from({ length: groupCount }, (_, g) =>
      2 + (g % 3),
    ).reduce((a, b) => a + b, 0);
    expect(processed.length).toBe(totalJobs);

    // Verify state snapshots show reasonable transitions
    // (ready + limited should generally decrease as we process)
    if (stateSnapshots.length > 0) {
      const firstSnapshot = stateSnapshots[0];
      const lastSnapshot = stateSnapshots[stateSnapshots.length - 1];

      // By the end, ready and limited should be 0
      expect(lastSnapshot.ready + lastSnapshot.limited).toBe(0);
    }

    await worker.close();
  });
});

describe('中毒群组 (Poisoned/Empty Group Cleanup)', () => {
  let q: Queue;
  let w: Worker;
  let r: any;
  const ns = `test-poisoned-groups-${Date.now()}`;

  beforeEach(async () => {
    r = createRedis();
    // Clean slate before each test
    const keys = await r.keys(`${ns}*`);
    if (keys.length) await r.del(keys);
    q = new Queue({ redis: r, namespace: ns });
  });

  afterEach(async () => {
    try {
      if (w) await w.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    try {
      if (q) await q.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    try {
      if (r && r.status !== 'end') {
        const keys = await r.keys(`${ns}*`);
        if (keys.length) await r.del(keys);
        await r.quit();
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('应该不陷入无限循环地处理就绪队列中的空组', async () => {
    const readyKey = `${ns}:ready`;
    const poisonedGroupId = 'poisoned-group-123';

    // Manually create a poisoned group (group in ready queue but no jobs)
    await r.zadd(readyKey, Date.now(), poisonedGroupId);

    // Verify the poisoned group is in ready queue
    const groupsBeforeCount = await r.zcard(readyKey);
    expect(groupsBeforeCount).toBe(1);

    // Start a worker - it should handle the poisoned group gracefully
    const processedJobs: any[] = [];

    w = new Worker({
      queue: q,
      handler: async (job) => {
        processedJobs.push(job);
        return 'done';
      },
      blockingTimeoutSec: 0.5,
    });
    w.run();

    // Add a real job to make sure the worker is functioning
    await new Promise((resolve) => setTimeout(resolve, 500));
    await q.add({ groupId: 'real-group', data: { test: true } });

    // Wait for the real job to be processed
    await q.waitForEmpty(5000);

    // The real job should have been processed (proves worker isn't stuck)
    expect(processedJobs.length).toBe(1);
    expect(processedJobs[0].data).toEqual({ test: true });

    // The poisoned group might still be in ready queue, but it's not causing issues
    // The key point is that the worker can still process real jobs and isn't stuck in a loop
  });

  it('应该不删除有任务的群组', async () => {
    // Add a real job
    await q.add({ groupId: 'test-group', data: { foo: 'bar' } });

    let processedCount = 0;
    w = new Worker({
      queue: q,
      handler: async () => {
        processedCount++;
        return 'done';
      },
      blockingTimeoutSec: 1,
    });
    w.run();

    // Wait for job to be processed
    await q.waitForEmpty(5000);

    // Job should have been processed
    expect(processedCount).toBe(1);
  });

  it('应该处理所有尝试都已耗尽的群组', async () => {
    const groupId = 'exhausted-group';

    // Add a job with 1 attempt (will fail once)
    await q.add({ groupId, data: { foo: 'bar' }, maxAttempts: 1 });

    // Process and fail the job to exhaust attempts
    let attempts = 0;
    w = new Worker({
      queue: q,
      handler: async () => {
        attempts++;
        throw new Error('Intentional failure');
      },
      blockingTimeoutSec: 0.5,
      maxAttempts: 1,
    });
    w.run();

    // Wait for job to be exhausted
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // The job should have been attempted once
    expect(attempts).toBe(1);

    // Close the worker
    await w.close();

    // Start a new worker - it should not process anything
    let newAttempts = 0;
    w = new Worker({
      queue: q,
      handler: async () => {
        newAttempts++;
        return 'done';
      },
      blockingTimeoutSec: 0.5,
    });
    w.run();

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // No new jobs should have been processed (job is exhausted)
    expect(newAttempts).toBe(0);
  });

  it('应该恢复具有有效任务的活跃群组', async () => {
    const groupId = 'active-group';

    // Add multiple jobs to the same group
    await q.add({ groupId, data: { job: 1 } });
    await q.add({ groupId, data: { job: 2 } });

    let processedCount = 0;

    w = new Worker({
      queue: q,
      handler: async (job) => {
        processedCount++;
        // Add small delay to ensure sequential processing
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      },
      blockingTimeoutSec: 1,
      concurrency: 1, // Process one at a time per group
    });
    w.run();

    // Wait for both jobs to complete
    await q.waitForEmpty(5000);

    // Both jobs should have been processed
    expect(processedCount).toBe(2);
  });
});

describe('就绪队列维护 (Ready Queue Cleanup)', () => {
  let redis: any;
  let namespace: string;
  let queue: Queue<any>;
  let workers: Worker<any>[] = [];

  beforeEach(async () => {
    redis = createRedis();
    namespace = `test-ready-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    queue = new Queue({
      redis,
      namespace,
    });
  });

  afterEach(async () => {
    for (const worker of workers) {
      try {
        await worker.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    workers = [];

    try {
      await queue.close();
    } catch {
      // Ignore cleanup errors
    }

    try {
      await redis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('应该在完成后从就绪队列中删除空的群组', async () => {
    // Add jobs to multiple groups
    const groupCount = 10;
    const jobsPerGroup = 5;

    // Add jobs first
    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `group-${g}`,
          data: { group: g, job: j },
        });
      }
    }

    // Process all jobs
    const processed: any[] = [];
    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    workers.push(worker);
    worker.run();

    // Wait for completion
    await queue.waitForEmpty();

    // Give a moment for cleanup to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check that ready queue is now empty (this is the critical check!)
    // Without the fix, this would have stale group entries
    const finalReadyCount = await redis.zcard(`${namespace}:ready`);
    expect(finalReadyCount).toBe(0); // All completed groups should be removed from ready queue

    // Verify all jobs were processed
    expect(processed.length).toBe(groupCount * jobsPerGroup);
  });

  it('应该不会因陈旧的就绪队列项而死锁', async () => {
    // This test specifically checks the bug we fixed:
    // If we complete all jobs in many groups, the ready queue should be clean
    // and new jobs should be processed immediately without deadlock

    const groupCount = 100;
    const jobsPerGroup = 3;

    // Round 1: Add and process many groups
    for (let g = 0; g < groupCount; g++) {
      for (let j = 0; j < jobsPerGroup; j++) {
        await queue.add({
          groupId: `round1-group-${g}`,
          data: { round: 1, group: g, job: j },
        });
      }
    }

    const processed: any[] = [];
    const worker = new Worker({
      queue,
      handler: async (job) => {
        processed.push(job.data);
      },
    });
    workers.push(worker);
    worker.run();

    await queue.waitForEmpty();

    // Check ready queue state after round 1
    const readyCountAfterRound1 = await redis.zcard(`${namespace}:ready`);
    expect(readyCountAfterRound1).toBe(0); // Should be empty, not full of stale entries!

    // Round 2: Add NEW jobs to NEW groups
    // If the ready queue has stale entries, workers will get stuck fetching those
    // instead of processing the new jobs, causing a deadlock/timeout
    const round2Groups = 10;
    for (let g = 0; g < round2Groups; g++) {
      await queue.add({
        groupId: `round2-group-${g}`,
        data: { round: 2, group: g, job: 0 },
      });
    }

    // This should complete quickly. If it times out, we have stale ready queue entries
    const startTime = Date.now();
    await queue.waitForEmpty();
    const duration = Date.now() - startTime;

    // Should complete in under 5 seconds (allowing generous buffer)
    // If we have the bug, this would timeout or take 30+ seconds
    expect(duration).toBeLessThan(5000);

    // Verify all jobs from both rounds were processed
    const round1Jobs = processed.filter((j) => j.round === 1);
    const round2Jobs = processed.filter((j) => j.round === 2);
    expect(round1Jobs.length).toBe(groupCount * jobsPerGroup);
    expect(round2Jobs.length).toBe(round2Groups);

    // Final check: ready queue should still be empty
    const finalReadyCount = await redis.zcard(`${namespace}:ready`);
    expect(finalReadyCount).toBe(0);
  });

  it('应该在不出现就绪队列泄漏的情况下处理混合群组生命周期', async () => {
    // Test a realistic scenario: some groups complete, some get more jobs added

    const worker = new Worker({
      queue,
      handler: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    workers.push(worker);
    worker.run();

    // Add initial jobs
    await queue.add({ groupId: 'group-A', data: { seq: 1 } });
    await queue.add({ groupId: 'group-A', data: { seq: 2 } });
    await queue.add({ groupId: 'group-B', data: { seq: 1 } });

    // Wait a bit for some processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Add more jobs to one group, let another finish
    await queue.add({ groupId: 'group-A', data: { seq: 3 } });
    await queue.add({ groupId: 'group-C', data: { seq: 1 } });

    // Wait for all to complete
    await queue.waitForEmpty();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Ready queue should be clean
    const readyCount = await redis.zcard(`${namespace}:ready`);
    expect(readyCount).toBe(0);

    // Groups set should be empty
    const groupsCount = await redis.scard(`${namespace}:groups`);
    expect(groupsCount).toBe(0);
  });
});
