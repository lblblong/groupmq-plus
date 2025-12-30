import type { Queue } from './queue';
import type { Worker } from './worker';

/**
 * Options for waitForEmpty
 */
export type WaitForEmptyOptions = {
  /** Maximum time to wait in milliseconds (default: 60 seconds) */
  timeoutMs?: number;
  /** Polling interval in milliseconds (default: 200) */
  intervalMs?: number;
  /** Ignore delayed jobs when checking if queue is empty */
  ignoreDelayed?: boolean;
  /** Ignore staged jobs when checking if queue is empty */
  ignoreStaged?: boolean;
  /** Throw error on timeout instead of returning false (default: false) */
  throwOnTimeout?: boolean;
};

/**
 * Queue state snapshot for debugging
 */
export type QueueStateSnapshot = {
  active: number;
  waiting: number;
  delayed: number;
  staged: number;
  limited: number;
  ready: number;
};

/**
 * Error thrown when waitForEmpty times out
 */
export class WaitForEmptyTimeoutError extends Error {
  public readonly state: QueueStateSnapshot;
  public readonly timeoutMs: number;

  constructor(state: QueueStateSnapshot, timeoutMs: number) {
    const stateStr = `Active=${state.active}, Waiting=${state.waiting}, Delayed=${state.delayed}, Staged=${state.staged}, Limited=${state.limited}, Ready=${state.ready}`;
    super(`waitForEmpty timed out after ${timeoutMs}ms. State: ${stateStr}`);
    this.name = 'WaitForEmptyTimeoutError';
    this.state = state;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wait for a queue to become empty
 * @param queue The queue to monitor
 * @param optionsOrTimeout Options object or timeout in milliseconds
 * @returns Promise that resolves to true when queue is empty, false if timeout reached (unless throwOnTimeout is true)
 * @throws WaitForEmptyTimeoutError if throwOnTimeout is true and timeout is reached
 */
export async function waitForQueueToEmpty(
  queue: Queue,
  optionsOrTimeout: WaitForEmptyOptions | number = 60_000,
): Promise<boolean> {
  const options: WaitForEmptyOptions = typeof optionsOrTimeout === 'number'
    ? { timeoutMs: optionsOrTimeout }
    : optionsOrTimeout;

  return queue.waitForEmpty(options);
}

/**
 * Generic polling utility that waits until a predicate returns true
 * @param predicate Async function that returns true when condition is met
 * @param timeoutMs Maximum time to wait (default: 30 seconds)
 * @param intervalMs Polling interval (default: 100ms)
 * @returns Promise that resolves to true if predicate became true, false if timeout
 */
export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await predicate();
      if (result) {
        return true;
      }
    } catch {
      // Predicate threw an error, continue polling
    }
    await sleep(intervalMs);
  }

  return false;
}

/**
 * Wait until a predicate returns true, throwing an error on timeout
 * @param predicate Async function that returns true when condition is met
 * @param errorMessage Error message to throw on timeout
 * @param timeoutMs Maximum time to wait (default: 30 seconds)
 * @param intervalMs Polling interval (default: 100ms)
 * @throws Error if timeout is reached
 */
export async function waitUntilOrThrow(
  predicate: () => Promise<boolean> | boolean,
  errorMessage: string,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<void> {
  const success = await waitUntil(predicate, timeoutMs, intervalMs);
  if (!success) {
    throw new Error(`${errorMessage} (timed out after ${timeoutMs}ms)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get status of all workers
 */
export function getWorkersStatus<T = any>(
  workers: Worker<T>[],
): {
  total: number;
  processing: number;
  idle: number;
  workers: Array<{
    index: number;
    isProcessing: boolean;
    currentJob?: {
      jobId: string;
      groupId: string;
      processingTimeMs: number;
    };
  }>;
} {
  const workersStatus = workers.map((worker, index) => {
    const currentJob = worker.getCurrentJob();
    return {
      index,
      isProcessing: worker.isProcessing(),
      currentJob: currentJob
        ? {
          jobId: currentJob.job.id,
          groupId: currentJob.job.groupId,
          processingTimeMs: currentJob.processingTimeMs,
        }
        : undefined,
    };
  });

  const processing = workersStatus.filter((w) => w.isProcessing).length;
  const idle = workersStatus.length - processing;

  return {
    total: workers.length,
    processing,
    idle,
    workers: workersStatus,
  };
}
