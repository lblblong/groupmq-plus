import type { Queue, ReservedJob } from '../queue';

export interface DispatchStrategy {
  /**
   * 尝试获取下一个可执行的任务
   * 
   * 策略内部负责完整的获取流程：
   * 1. 批量获取处于 Ready 状态的 Group
   * 2. 应用优先级排序逻辑
   * 3. 循环尝试从排序后的 Group 中获取任务
   * 4. 处理"并发已满 (E_LIMIT)"和"队列为空"两种失败状态
   * 5. 返回第一个成功获取的任务，或 null（无可用任务）
   * 
   * 此接口设计体现了 IoC（控制反转）原则：
   * - Worker 只需简单调用此方法，无需关心具体选择逻辑
   * - Strategy 掌控"如何获取"的全过程
   * - 不同的 Strategy 可以实现不同的分派算法（优先级、加权、衰减等）
   * 
   * @param queue - Queue 实例，用于获取 Group 和尝试保留任务
   * @returns 成功获取的任务，或 null（暂无可用任务）
   */
  acquireJob(queue: Queue<any>): Promise<ReservedJob<any> | null>;

  /**
   * 当 acquireJob 返回 null (无任务) 时，建议 Worker 休眠的时间 (毫秒)
   * 如果未定义，Worker 将使用默认值
   */
  readonly idleInterval: number;
}
