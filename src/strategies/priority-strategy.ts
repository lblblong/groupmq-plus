import { DispatchStrategy } from './dispatch-strategy';
import type { GroupConfig, Queue, ReservedJob } from '../queue';

type CacheEntry = { priority: number; expiresAt: number };
type PriorityStrategyGroupConfig = GroupConfig & { priority: number; };

/**
 * 自定义优先级计算函数
 * @param groupId 组 ID
 * @param config 从 Redis 读取的组配置
 * @returns 优先级数值（数字越大优先级越高）
 */
export type OnGetPriority = (
  groupId: string,
  config: PriorityStrategyGroupConfig,
) => number | Promise<number>;

// ============ 算法配置类型 ============

/** 严格优先级算法：总是选择优先级最高的组 */
export type StrictAlgorithmConfig = { type: 'strict' };

/** 加权随机算法（默认）：根据优先级权重概率选择，避免低优先级饥饿 */
export type WeightedRandomAlgorithmConfig = {
  type: 'weighted-random';
  /** 最低权重比例，默认 0.1 */
  minWeightRatio?: number;
};

/** 时间衰减算法：等待时间越长，优先级加成越高 */
export type AgingAlgorithmConfig = {
  type: 'aging';
  /** 每增加1点优先级需要的等待毫秒数，默认 60000 */
  intervalMs?: number;
};

export type AlgorithmConfig =
  | StrictAlgorithmConfig
  | WeightedRandomAlgorithmConfig
  | AgingAlgorithmConfig;

// ============ 策略选项 ============

export interface PriorityStrategyOptions {
  /**
   * 调度算法类型
   * @default { type: 'weighted-random' }
   */
  algorithm?: AlgorithmConfig;

  /** 
   * 默认优先级（当无法获取配置时的回退值）
   * @default 1 
   */
  defaultPriority?: number;

  /** 
   * 优先级缓存时间（毫秒），设为 0 禁用缓存
   * @default 5000 
   */
  cacheTtlMs?: number;

  /**
   * 自定义优先级获取逻辑
   * 如果提供，将优先使用此函数计算优先级
   */
  onGetPriority?: OnGetPriority;

  /**
   * 当没有任务时，Worker 的轮询间隔 (ms)
   * @default 50
   */
  pollInterval?: number;
}

type GroupPriorityInfo = {
  groupId: string;
  priority: number;
  /** 组内最老任务的入队时间戳（仅 aging 算法使用） */
  oldestTimestamp?: number;
};

/**
 * 基于优先级的调度策略
 * 
 * 此策略负责根据 Group 的优先级决定处理顺序。
 * 它支持多种排序算法（严格优先、加权随机、时间衰减），
 * 并实现了"快速试错"（Fallthrough）机制以应对并发限制。
 */
export class PriorityStrategy implements DispatchStrategy {
  /** 本地缓存：groupId -> { priority, expiresAt } */
  private cache = new Map<string, CacheEntry>();

  private algorithmConfig: AlgorithmConfig;
  private defaultPriority: number;
  private cacheTtlMs: number;
  private onGetPriority?: OnGetPriority;
  public readonly idleInterval: number;

  constructor(options: PriorityStrategyOptions = {}) {
    this.algorithmConfig = options.algorithm ?? { type: 'weighted-random' };
    this.defaultPriority = options.defaultPriority ?? 1;
    this.cacheTtlMs = options.cacheTtlMs ?? 5000;
    this.onGetPriority = options.onGetPriority;
    this.idleInterval = options.pollInterval ?? 50;
  }

  /**
   * 获取下一个可执行的任务
   * 
   * 实现逻辑：
   * 1. 批量获取当前活跃的 Group（Batch Fetch）
   * 2. 解析每个 Group 的优先级（Resolve Priority）
   * 3. 根据算法对 Group 进行排序（Sort）
   * 4. 依次尝试获取任务，遇到并发限制则快速跳过（Reserve & Fallthrough）
   */
  async acquireJob(queue: Queue<any>): Promise<ReservedJob<any> | null> {
    // 1. 获取当前所有处于 Ready 状态的 Group（限制为前 100 个以避免内存溢出）
    const readyGroups = await queue.getReadyGroups(0, 100);

    if (readyGroups.length === 0) {
      return null;
    }

    // 2. 批量获取优先级信息
    const groupInfos: GroupPriorityInfo[] = await Promise.all(
      readyGroups.map(async (groupId) => {
        const priority = await this.resolvePriority(queue, groupId);
        const info: GroupPriorityInfo = { groupId, priority };

        // 仅 aging 算法需要获取额外的时间戳信息
        if (this.algorithmConfig.type === 'aging') {
          info.oldestTimestamp = await queue.getGroupOldestTimestamp(groupId);
        }

        return info;
      }),
    );

    // 3. 根据配置的算法对 Group 进行排序
    const sortedGroupIds = this.sortGroupsByPriority(groupInfos);

    // 4. 循环尝试从排序后的 Group 列表中获取任务
    for (const groupId of sortedGroupIds) {
      const result = await queue.reserveAtomic(groupId);

      if (result.status === 'success') {
        // 成功获取任务，立即返回
        return result.job;
      }

      // status === 'limit_exceeded': 该高优组并发已满，立即 continue 尝试下一个次优组
      // status === 'empty': 该组瞬间被清空，continue 尝试下一个
    }

    // 5. 所有候选 Group 都无法获取任务（都满了或都空了）
    return null;
  }

  /**
   * 解析组的优先级
   * 优先级来源顺序：Cache -> onGetPriority -> Redis Config -> Default
   */
  private async resolvePriority(
    queue: Queue<any>,
    groupId: string,
  ): Promise<number> {
    // 1. 检查缓存是否有效
    const now = Date.now();
    const cached = this.cache.get(groupId);
    if (cached && cached.expiresAt > now) {
      return cached.priority;
    }

    // 2. 获取基础配置（用于传给 onGetPriority）
    const config = await queue.getGroupConfig<PriorityStrategyGroupConfig>(groupId);

    // 3. 计算优先级
    let priority: number;
    if (this.onGetPriority) {
      // 如果用户提供了自定义函数，使用它
      priority = await this.onGetPriority(groupId, config);
    } else {
      // 否则使用 Redis 中的配置，若无则使用默认值
      priority = config.priority !== 1 ? config.priority : this.defaultPriority;
    }

    // 4. 更新缓存
    if (this.cacheTtlMs > 0) {
      this.cache.set(groupId, {
        priority,
        expiresAt: now + this.cacheTtlMs,
      });
    }

    return priority;
  }

  /**
   * 根据算法类型分发排序逻辑
   */
  private sortGroupsByPriority(groups: GroupPriorityInfo[]): string[] {
    switch (this.algorithmConfig.type) {
      case 'strict':
        return this.sortByStrict(groups);
      case 'aging':
        return this.sortByAging(groups);
      case 'weighted-random':
      default:
        return this.sortByWeightedRandom(groups);
    }
  }

  /**
   * 严格优先级排序：Priority 大的排前面
   */
  private sortByStrict(groups: GroupPriorityInfo[]): string[] {
    // 降序排列
    const sorted = [...groups].sort((a, b) => b.priority - a.priority);
    return sorted.map((g) => g.groupId);
  }

  /**
   * 加权随机排序：Priority 越高，排在前面的概率越大
   */
  private sortByWeightedRandom(groups: GroupPriorityInfo[]): string[] {
    if (groups.length === 1) return [groups[0].groupId];

    const config = this.algorithmConfig as WeightedRandomAlgorithmConfig;
    const minWeightRatio = config.minWeightRatio ?? 0.1;

    // 找出最大优先级，用于计算保底权重
    const maxPriority = Math.max(...groups.map((g) => g.priority));
    const minWeight = maxPriority * minWeightRatio;

    // 构建权重表
    const weights = groups.map((g) => ({
      groupId: g.groupId,
      weight: Math.max(g.priority, minWeight),
    }));

    // 依次抽取
    const result: string[] = [];
    const remaining = new Map(weights.map((w) => [w.groupId, w.weight]));

    while (remaining.size > 0) {
      const remainingEntries = Array.from(remaining.entries());
      const totalWeight = remainingEntries.reduce((sum, [_, w]) => sum + w, 0);

      let random = Math.random() * totalWeight;
      let selectedGroupId: string | null = null;

      for (const [groupId, weight] of remainingEntries) {
        random -= weight;
        if (random <= 0) {
          selectedGroupId = groupId;
          break;
        }
      }

      // 兜底：浮点数精度问题可能导致没选中，默认选第一个
      if (!selectedGroupId) {
        selectedGroupId = remainingEntries[0][0];
      }

      result.push(selectedGroupId);
      remaining.delete(selectedGroupId);
    }

    return result;
  }

  /**
   * 时间衰减排序：Priority + 等待时间加成
   */
  private sortByAging(groups: GroupPriorityInfo[]): string[] {
    const now = Date.now();
    const config = this.algorithmConfig as AgingAlgorithmConfig;
    const intervalMs = config.intervalMs ?? 60000;

    const adjustedGroups = groups.map((g) => {
      let ageBonus = 0;
      if (g.oldestTimestamp) {
        const waitTime = now - g.oldestTimestamp;
        // 每过 intervalMs 时间，优先级 +1
        ageBonus = Math.floor(waitTime / intervalMs);
      }
      return {
        groupId: g.groupId,
        // 计算最终动态优先级
        adjustedPriority: g.priority + ageBonus,
      };
    });

    // 按调整后的优先级降序排列
    adjustedGroups.sort((a, b) => b.adjustedPriority - a.adjustedPriority);
    return adjustedGroups.map((g) => g.groupId);
  }
}