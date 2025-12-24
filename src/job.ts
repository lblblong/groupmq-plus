import type { Queue, ReservedJob } from './queue';
import type { Status } from './status';

export class Job<T = any> {
  public readonly queue: Queue<T>;
  public readonly id: string;
  public readonly name: string;
  public readonly data: T;
  public readonly groupId: string;
  public readonly attemptsMade: number;
  public readonly opts: { attempts: number; delay?: number };
  public readonly processedOn?: number;
  public readonly finishedOn?: number;
  public readonly failedReason: string;
  public readonly stacktrace?: string;
  public readonly returnvalue?: any;
  public readonly timestamp: number; // ms
  public readonly orderMs?: number;
  public readonly status: Status | 'unknown';
  public readonly parentId?: string;

  constructor(args: {
    queue: Queue<T>;
    id: string;
    name?: string;
    data: T;
    groupId: string;
    attemptsMade: number;
    opts: { attempts: number; delay?: number };
    processedOn?: number;
    finishedOn?: number;
    failedReason?: string;
    stacktrace?: string;
    returnvalue?: any;
    timestamp: number;
    orderMs?: number;
    status?: Status | 'unknown';
    parentId?: string;
  }) {
    this.queue = args.queue;
    this.id = args.id;
    this.name = args.name ?? 'groupmq';
    this.data = args.data;
    this.groupId = args.groupId;
    this.attemptsMade = args.attemptsMade;
    this.opts = args.opts;
    this.processedOn = args.processedOn;
    this.finishedOn = args.finishedOn;
    this.failedReason = args.failedReason as any;
    this.stacktrace = args.stacktrace as any;
    this.returnvalue = args.returnvalue;
    this.timestamp = args.timestamp;
    this.orderMs = args.orderMs;
    this.status = args.status ?? 'unknown';
    this.parentId = args.parentId;
  }

  async getState(): Promise<
    Status | 'stuck' | 'waiting-children' | 'prioritized' | 'unknown'
  > {
    return this.status ?? 'unknown';
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      data: this.data,
      groupId: this.groupId,
      attemptsMade: this.attemptsMade,
      opts: this.opts,
      processedOn: this.processedOn,
      finishedOn: this.finishedOn,
      failedReason: this.failedReason,
      stacktrace: this.stacktrace ? [this.stacktrace] : null,
      returnvalue: this.returnvalue,
      timestamp: this.timestamp,
      orderMs: this.orderMs,
      status: this.status,
      progress: 0, // Default progress value
    };
  }

  changeDelay(newDelay: number): Promise<boolean> {
    return this.queue.changeDelay(this.id, newDelay);
  }

  async promote(): Promise<void> {
    await this.queue.promote(this.id);
  }

  async remove(): Promise<void> {
    await this.queue.remove(this.id);
  }

  async retry(_state?: Extract<Status, 'completed' | 'failed'>): Promise<void> {
    await this.queue.retry(this.id);
  }

  async updateData(jobData: T): Promise<void> {
    await this.queue.updateData(this.id, jobData);
  }

  async update(jobData: T): Promise<void> {
    await this.updateData(jobData);
  }

  /**
   * Wait until this job is completed or failed.
   * @param timeoutMs Optional timeout in milliseconds (0 = no timeout)
   */
  async waitUntilFinished(timeoutMs = 0): Promise<unknown> {
    return this.queue.waitUntilFinished(this.id, timeoutMs);
  }

  /**
   * Get all child jobs of this job (if it's a parent in a flow).
   * @returns Array of child Job instances
   */
  async getChildren(): Promise<Job<any>[]> {
    return this.queue.getFlowChildren(this.id);
  }

  /**
   * Get the return values of all child jobs in a flow.
   * @returns Object mapping child job IDs to their return values
   */
  async getChildrenValues(): Promise<Record<string, any>> {
    return this.queue.getFlowResults(this.id);
  }

  /**
   * Get the number of remaining child jobs that haven't completed yet.
   * @returns Number of remaining dependencies, or null if not a parent job
   */
  async getDependenciesCount(): Promise<number | null> {
    return this.queue.getFlowDependencies(this.id);
  }

  /**
   * Get the parent job of this job (if it's a child in a flow).
   * @returns Parent Job instance, or undefined if no parent or parent was deleted
   */
  async getParent(): Promise<Job<any> | undefined> {
    if (!this.parentId) return undefined;
    try {
      return await this.queue.getJob(this.parentId);
    } catch (_e) {
      // Parent job may have been deleted
      return undefined;
    }
  }

  static fromReserved<T = any>(
    queue: Queue<T>,
    reserved: ReservedJob<T>,
    meta?: {
      processedOn?: number;
      finishedOn?: number;
      failedReason?: string;
      stacktrace?: string;
      returnvalue?: any;
      status?: Status | string;
      delayMs?: number;
    },
  ): Job<T> {
    return new Job<T>({
      queue,
      id: reserved.id,
      name: 'groupmq',
      data: reserved.data as T,
      groupId: reserved.groupId,
      attemptsMade: reserved.attempts,
      opts: {
        attempts: reserved.maxAttempts,
        delay: meta?.delayMs,
      },
      processedOn: meta?.processedOn,
      finishedOn: meta?.finishedOn,
      failedReason: meta?.failedReason,
      stacktrace: meta?.stacktrace,
      returnvalue: meta?.returnvalue,
      timestamp: reserved.timestamp ? reserved.timestamp : Date.now(),
      orderMs: reserved.orderMs,
      status: coerceStatus(meta?.status as any),
    });
  }

  /**
   * Create a Job from raw Redis hash data with optional known status
   * This avoids extra Redis lookups when status is already known
   */
  static fromRawHash<T = any>(
    queue: Queue<T>,
    id: string,
    raw: Record<string, string>,
    knownStatus?: Status | 'unknown',
  ): Job<T> {
    const groupId = raw.groupId ?? '';
    const payload = raw.data ? safeJsonParse(raw.data) : null;
    const attempts = raw.attempts ? parseInt(raw.attempts, 10) : 0;
    const maxAttempts = raw.maxAttempts
      ? parseInt(raw.maxAttempts, 10)
      : queue.maxAttemptsDefault;
    const timestampMs = raw.timestamp ? parseInt(raw.timestamp, 10) : 0;
    const orderMs = raw.orderMs ? parseInt(raw.orderMs, 10) : undefined;
    const delayUntil = raw.delayUntil ? parseInt(raw.delayUntil, 10) : 0;
    const processedOn = raw.processedOn
      ? parseInt(raw.processedOn, 10)
      : undefined;
    const finishedOn = raw.finishedOn
      ? parseInt(raw.finishedOn, 10)
      : undefined;
    const failedReason =
      (raw.failedReason ?? raw.lastErrorMessage) || undefined;
    const stacktrace = (raw.stacktrace ?? raw.lastErrorStack) || undefined;
    const returnvalue = raw.returnvalue
      ? safeJsonParse(raw.returnvalue)
      : undefined;
    const parentId = raw.parentId || undefined;

    return new Job<T>({
      queue,
      id,
      name: 'groupmq',
      data: payload as T,
      groupId,
      attemptsMade: attempts,
      opts: {
        attempts: maxAttempts,
        delay:
          delayUntil && delayUntil > Date.now()
            ? delayUntil - Date.now()
            : undefined,
      },
      processedOn,
      finishedOn,
      failedReason,
      stacktrace,
      returnvalue,
      timestamp: timestampMs || Date.now(),
      orderMs,
      status: knownStatus ?? coerceStatus(raw.status as any),
      parentId,
    });
  }

  static async fromStore<T = any>(
    queue: Queue<T>,
    id: string,
  ): Promise<Job<T>> {
    const jobKey = `${queue.namespace}:job:${id}`;
    const raw = await queue.redis.hgetall(jobKey);
    if (!raw || Object.keys(raw).length === 0) {
      throw new Error(`Job ${id} not found`);
    }

    const groupId = raw.groupId ?? '';
    const payload = raw.data ? safeJsonParse(raw.data) : null;
    const attempts = raw.attempts ? parseInt(raw.attempts, 10) : 0;
    const maxAttempts = raw.maxAttempts
      ? parseInt(raw.maxAttempts, 10)
      : queue.maxAttemptsDefault;
    const timestampMs = raw.timestamp ? parseInt(raw.timestamp, 10) : 0;
    const orderMs = raw.orderMs ? parseInt(raw.orderMs, 10) : undefined;
    const delayUntil = raw.delayUntil ? parseInt(raw.delayUntil, 10) : 0;
    const processedOn = raw.processedOn
      ? parseInt(raw.processedOn, 10)
      : undefined;
    const finishedOn = raw.finishedOn
      ? parseInt(raw.finishedOn, 10)
      : undefined;
    const failedReason =
      (raw.failedReason ?? raw.lastErrorMessage) || undefined;
    const stacktrace = (raw.stacktrace ?? raw.lastErrorStack) || undefined;
    const returnvalue = raw.returnvalue
      ? safeJsonParse(raw.returnvalue)
      : undefined;
    const parentId = raw.parentId || undefined;

    // Determine status
    const [inProcessing, inDelayed] = await Promise.all([
      queue.redis.zscore(`${queue.namespace}:processing`, id),
      queue.redis.zscore(`${queue.namespace}:delayed`, id),
    ]);

    let status: string | undefined = raw.status;
    if (inProcessing !== null) status = 'active';
    else if (inDelayed !== null) status = 'delayed';
    else if (groupId) {
      const inGroup = await queue.redis.zscore(
        `${queue.namespace}:g:${groupId}`,
        id,
      );
      if (inGroup !== null) status = 'waiting';
    }

    return new Job<T>({
      queue,
      id,
      name: 'groupmq',
      data: payload as T,
      groupId,
      attemptsMade: attempts,
      opts: {
        attempts: maxAttempts,
        delay:
          delayUntil && delayUntil > Date.now()
            ? delayUntil - Date.now()
            : undefined,
      },
      processedOn,
      finishedOn,
      failedReason,
      stacktrace,
      returnvalue,
      timestamp: timestampMs || Date.now(),
      orderMs,
      status: coerceStatus(status as any),
      parentId,
    });
  }
}

function safeJsonParse(input: string): any {
  try {
    return JSON.parse(input);
  } catch (_e) {
    return null;
  }
}

function coerceStatus(input?: string | Status): Status | 'unknown' {
  const valid: Array<Status> = [
    'latest',
    'active',
    'waiting',
    'waiting-children',
    'prioritized',
    'completed',
    'failed',
    'delayed',
    'paused',
  ];
  if (!input) return 'unknown';
  if (valid.includes(input as Status)) return input as Status;
  return 'unknown';
}
