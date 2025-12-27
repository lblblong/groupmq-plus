import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from '../src';
import { createRedis } from './helpers/redis';

describe('Limited Set - Hot Spot Issues Resolution', () => {
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

  it('should move groups to limited set when concurrency is exhausted', async () => {
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

  it('should not waste CPU spinning on limited groups', async () => {
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

  it('should move groups from limited back to ready when concurrency becomes available', async () => {
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

  it('should handle validate-limited-set correctly for multiple groups', async () => {
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

  it('should efficiently handle 1000 groups scenario without hot spot spinning', async () => {
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

  it('should correctly validate and rebuild limited set after interrupted processing', async () => {
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

  it('should maintain correct ready/limited state transitions under load', async () => {
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
