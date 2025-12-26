import { DispatchStrategy } from './dispatch-strategy';
import type { Queue, ReservedJob } from '../queue';

export interface RoundRobinStrategyOptions {
  /**
   * 每次轮询获取的候选 Group 数量
   * 数量越大，公平性范围越广，但 Redis 读取负载略微增加
   * @default 50
   */
  batchSize?: number;
  pollInterval?: number;
}

/**
 * 公平轮询策略 (Round Robin)
 * 
 * 适用场景：
 * - 多租户系统 (SaaS)
 * - 需要防止某个 Group 的海量任务 "饿死" 其他 Group 的场景
 * 
 * 工作原理：
 * 1. 从 Redis 获取一批当前等待最久的 Group (Batch Fetch)
 * 2. 在本地对这批 Group 进行随机洗牌 (Shuffle)
 * 3. 依次尝试获取任务
 * 4. 遇到并发限制 (Limit Exceeded) 自动跳过，尝试下一个
 */
export class RoundRobinStrategy implements DispatchStrategy {
  private batchSize: number;
  public readonly idleInterval: number;

  constructor(options: RoundRobinStrategyOptions = {}) {
    this.batchSize = options.batchSize ?? 50;
    this.idleInterval = options.pollInterval ?? 50;
  }

  async acquireJob(queue: Queue<any>): Promise<ReservedJob<any> | null> {
    // 1. 获取一批“有活干”的 Group (Redis ZSET 按等待时间排序)
    //    我们获取前 N 个，在这个范围内做公平调度
    const readyGroups = await queue.getReadyGroups(0, this.batchSize - 1);

    if (readyGroups.length === 0) {
      return null;
    }

    // 2. 随机洗牌 (Shuffle)
    //    这是实现 "Round Robin" / 公平性的关键。
    //    如果不洗牌，Worker 总是会先尝试 list[0]，导致 list[0] 的 Group 即使并发没满，
    //    也会因为 Worker 数量多而抢占大部分资源。洗牌后，机会均等。
    this.shuffle(readyGroups);

    // 3. 快速试错循环 (Failover Loop)
    for (const groupId of readyGroups) {
      // 尝试抢占
      const result = await queue.reserveAtomic(groupId);

      if (result.status === 'success') {
        // 抢到了！直接返回任务
        return result.job;
      }

      // 如果是 'limit_exceeded' (该组并发满了)
      // 或者 'empty' (刚才还在现在没了)
      // -> 直接 continue，毫秒级尝试列表中的下一个 Group
    }

    // 4.这一批都试完了，没拿到任务
    return null;
  }

  /**
   * Fisher-Yates 洗牌算法
   * 将数组元素原地随机打乱
   */
  private shuffle(array: string[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      // 生成 0 到 i 之间的随机整数
      const j = Math.floor(Math.random() * (i + 1));
      // 交换元素
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}