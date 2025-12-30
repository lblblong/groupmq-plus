import { describe, expect, test } from '../helpers/suite';
import type { LoggerInterface } from '../../src/logger';

/**
 * Test logger that captures race condition warnings for testing
 */
class TestLogger implements LoggerInterface {
  private raceConditionWarnings: string[] = [];

  debug(message: string, ...args: any[]): void {
    const fullMessage =
      args.length > 0 ? `${message} ${args.join(' ')}` : message;

    if (
      fullMessage.includes('race condition') ||
      fullMessage.includes('duplicate processing') ||
      fullMessage.includes('job already being processed') ||
      fullMessage.includes('concurrent access detected')
    ) {
      this.raceConditionWarnings.push(fullMessage);
    }
  }

  info(...args: any[]): void { }

  warn(message: string, ...args: any[]): void {
    const fullMessage =
      args.length > 0 ? `${message} ${args.join(' ')}` : message;
    if (
      fullMessage.includes('race condition') ||
      fullMessage.includes('duplicate processing') ||
      fullMessage.includes('job already being processed') ||
      fullMessage.includes('concurrent access detected')
    ) {
      this.raceConditionWarnings.push(fullMessage);
    }
  }

  error(message: string, ...args: any[]): void {
    const fullMessage =
      args.length > 0 ? `${message} ${args.join(' ')}` : message;

    if (
      fullMessage.includes('race condition') ||
      fullMessage.includes('duplicate processing') ||
      fullMessage.includes('job already being processed') ||
      fullMessage.includes('concurrent access detected')
    ) {
      this.raceConditionWarnings.push(fullMessage);
    }
  }

  getRaceConditionWarnings(): string[] {
    return [...this.raceConditionWarnings];
  }

  clearRaceConditionWarnings(): void {
    this.raceConditionWarnings = [];
  }

  getWarningCount(): number {
    return this.raceConditionWarnings.length;
  }
}

describe('Atomic Reserve Race Condition Tests', () => {
  test('should NOT produce race conditions with reserveAtomic under extreme contention', async ({ createQueue, createWorker }) => {
    const testLogger = new TestLogger();

    const testQueue = createQueue({
      jobTimeoutMs: 1000,
      logger: testLogger,
    });

    const groupCount = 3;
    const jobsPerGroup = 100;
    const totalJobs = groupCount * jobsPerGroup;

    for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
      const groupId = `atomic-contention-group-${groupIndex}`;
      for (let jobIndex = 0; jobIndex < jobsPerGroup; jobIndex++) {
        await testQueue.add({
          data: { group: groupIndex, job: jobIndex },
          groupId,
        });
      }
    }

    const workerCount = 15;
    const processedJobs: any[] = [];
    const workers: ReturnType<typeof createWorker>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = createWorker({
        queue: testQueue,
        name: `atomic-test-worker-${i}`,
        handler: async (job) => {
          processedJobs.push(job.data);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 10),
          );
          return `processed-${job.data.group}-${job.data.job}`;
        },
        logger: testLogger,
      });
      workers.push(worker);
    }

    workers.map((worker) => worker.run());

    const startTime = Date.now();
    const timeout = 30000;

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (processedJobs.length >= totalJobs || elapsed > timeout) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });

    expect(processedJobs).toHaveLength(totalJobs);

    const raceConditionWarnings = testLogger.getRaceConditionWarnings();
    const maxAllowedWarnings = Math.ceil(totalJobs * 0.02);

    expect(raceConditionWarnings.length).toBeLessThanOrEqual(
      maxAllowedWarnings,
    );

    const processedCounts = new Map<number, number>();
    for (const job of processedJobs) {
      const count = processedCounts.get(job.group) || 0;
      processedCounts.set(job.group, count + 1);
    }

    for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
      const processed = processedCounts.get(groupIndex) || 0;
      expect(processed).toBe(jobsPerGroup);
    }

    expect(processedJobs.length).toBe(totalJobs);
  }, 45000);

  test('should prevent multiple bounce-backs on same group', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      jobTimeoutMs: 5000,
      logger: false,
    });

    const groupId = 'single-group-test';
    const jobCount = 20;

    for (let i = 0; i < jobCount; i++) {
      await queue.add({
        data: { index: i },
        groupId,
      });
    }

    const processedJobs: any[] = [];
    const workers: ReturnType<typeof createWorker>[] = [];

    const workerCount = 6;
    for (let i = 0; i < workerCount; i++) {
      const workerName = `bounce-test-worker-${i}`;

      const worker = createWorker({
        queue,
        name: workerName,
        handler: async (job) => {
          processedJobs.push(job.data);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `processed-${job.data.index}`;
        },
      });
      workers.push(worker);
    }

    workers.map((worker) => worker.run());

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (processedJobs.length >= jobCount) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });

    expect(processedJobs).toHaveLength(jobCount);

    const indices = processedJobs.map((job) => job.index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: jobCount }, (_, i) => i));
  }, 30000);
});
