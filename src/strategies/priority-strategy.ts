import { DispatchStrategy } from './dispatch-strategy';
import type { Queue, ReservedJob } from '../queue';
import { GET_WEIGHTED_GROUPS_LUA } from './lua/get-weighted-groups';

// 定义 Lua 返回的数据结构
type LuaGroupResult = {
  id: string; // groupId
  p: number;  // priority
  ts: number; // oldest timestamp
};

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
   * 默认优先级（当无法从 Redis 获取配置时的回退值）
   * @default 1 
   */
  defaultPriority?: number;

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
 * 
 * 性能特性：
 * - 使用 Lua 脚本 (Deep Scan) 一次性获取所有候选组及其配置。
 * - 零网络往返延迟 (N+1 free)。
 * - 无本地缓存，实时响应 Redis 配置变更。
 */
export class PriorityStrategy implements DispatchStrategy {
  private algorithmConfig: AlgorithmConfig;
  private defaultPriority: number;
  public readonly idleInterval: number;

  constructor(options: PriorityStrategyOptions = {}) {
    this.algorithmConfig = options.algorithm ?? { type: 'weighted-random' };
    this.defaultPriority = options.defaultPriority ?? 1;
    this.idleInterval = options.pollInterval ?? 50;
  }

  /**
   * 获取下一个可执行的任务
   */
  async acquireJob(queue: Queue<any>): Promise<ReservedJob<any> | null> {
    // 1. 使用 Lua 脚本一次性获取 Ready 组及其配置
    //    这里 ARGV[1] (limit) 设为 100，如果你的组数量巨大且通过 add(groupConfig) 维护了优先级，
    //    可以考虑调大这个值，或者依赖 Lua 内部的 Top-K 过滤（如果未来需要支持海量组）。
    const resultJson = await queue.redis.eval(
      GET_WEIGHTED_GROUPS_LUA,
      1,
      queue.namespace,
      '100', // limit (batch fetch size)
      String(this.defaultPriority)
    ) as string;

    const rawGroups: LuaGroupResult[] = resultJson ? JSON.parse(resultJson) : [];

    if (rawGroups.length === 0) {
      return null;
    }

    // 2. 直接映射为内部格式
    //    不再需要任何回调或复杂的异步逻辑，因为 priority 已经由 Lua 准备好了
    const groupInfos: GroupPriorityInfo[] = rawGroups.map((g) => ({
      groupId: g.id,
      priority: g.p,
      oldestTimestamp: g.ts > 0 ? g.ts : undefined,
    }));

    // 3. 本地内存排序
    const sortedGroupIds = this.sortGroupsByPriority(groupInfos);

    // 4. 依次尝试获取 (Core 原子操作)
    for (const groupId of sortedGroupIds) {
      const result = await queue.reserveAtomic(groupId);

      if (result.status === 'success') {
        return result.job;
      }
      // status === 'limit_exceeded' | 'empty' -> Continue to next group
    }

    return null;
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

      // 兜底
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
        ageBonus = Math.floor(waitTime / intervalMs);
      }
      return {
        groupId: g.groupId,
        adjustedPriority: g.priority + ageBonus,
      };
    });

    // 降序排列
    adjustedGroups.sort((a, b) => b.adjustedPriority - a.adjustedPriority);
    return adjustedGroups.map((g) => g.groupId);
  }
}