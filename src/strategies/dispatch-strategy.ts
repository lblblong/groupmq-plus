import { Queue } from '../queue';

export interface DispatchStrategy {
  /**
   * 决定下一个应该处理的 Group ID。
   * 如果返回 null，表示根据策略当前没有合适的 Group 需要处理（或者队列为空）。
   */
  getNextGroup(queue: Queue<any>): Promise<string | null>;
}
