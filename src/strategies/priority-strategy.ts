import { DispatchStrategy } from './dispatch-strategy';
import { Queue } from '../queue';

type CacheEntry = { priority: number; expiresAt: number };
type GroupConfig = { priority: number; concurrency: number };

/**
 * 自定义优先级计算函数
 * @param groupId 组 ID
 * @param config 从 Redis 读取的组配置
 * @returns 优先级数值（数字越大优先级越高）
 */
export type OnGetPriority = (
  groupId: string,
  config: GroupConfig,
) => number | Promise<number>;

// ============ 算法配置类型（判别联合） ============

/**
 * 严格优先级算法
 * 总是选择优先级最高的组，可能导致低优先级组饥饿
 */
export type StrictAlgorithmConfig = {
  type: 'strict';
};

/**
 * 加权随机算法（默认）
 * 根据优先级计算概率选择，确保低优先级组也有机会被执行
 */
export type WeightedRandomAlgorithmConfig = {
  type: 'weighted-random';
  /**
   * 最低优先级组的保底权重比例，默认 0.1（10%）
   * 例如：VIP 优先级 100，普通用户优先级 1
   * 普通用户的权重会被提升到 100 * 0.1 = 10，而不是 1
   * 这样普通用户大约有 10/(100+10) ≈ 9% 的概率被选中
   */
  minWeightRatio?: number;
};

/**
 * 时间衰减算法
 * 等待时间越长，优先级加成越高，确保所有任务最终都会被执行
 */
export type AgingAlgorithmConfig = {
  type: 'aging';
  /**
   * 每等待多少毫秒增加 1 点优先级，默认 60000（1分钟）
   * 例如：VIP 优先级 100，普通用户优先级 1
   * 普通用户等待 100 分钟后，优先级变为 1 + 100 = 101，超过 VIP
   */
  intervalMs?: number;
};

/**
 * 算法配置类型
 */
export type AlgorithmConfig =
  | StrictAlgorithmConfig
  | WeightedRandomAlgorithmConfig
  | AgingAlgorithmConfig;

// ============ 策略选项 ============

export interface PriorityStrategyOptions {
  /**
   * 调度算法配置，默认 { type: 'weighted-random' }
   *
   * @example
   * // 严格优先级（VIP 绝对优先）
   * algorithm: { type: 'strict' }
   *
   * // 加权随机（默认，平衡公平性）
   * algorithm: { type: 'weighted-random', minWeightRatio: 0.1 }
   *
   * // 时间衰减（确保无饥饿）
   * algorithm: { type: 'aging', intervalMs: 60000 }
   */
  algorithm?: AlgorithmConfig;
  /** 默认优先级（未配置的组使用此值），默认 1 */
  defaultPriority?: number;
  /** 优先级缓存 TTL（毫秒），默认 5000ms。设为 0 禁用缓存 */
  cacheTtlMs?: number;
  /**
   * 自定义优先级计算函数
   * 如果提供，将使用此函数计算优先级，否则直接使用 config.priority
   *
   * @example
   * // 根据 VIP 等级计算优先级
   * onGetPriority: (groupId, config) => {
   *   if (groupId.startsWith('vip:')) return config.priority * 10;
   *   return config.priority;
   * }
   */
  onGetPriority?: OnGetPriority;
}

type GroupPriorityInfo = {
  groupId: string;
  priority: number;
  /** 组内最老任务的入队时间戳（用于 aging 算法） */
  oldestTimestamp?: number;
};

export class PriorityStrategy implements DispatchStrategy {
  /** 本地缓存：groupId -> { priority, expiresAt } */
  private cache = new Map<string, CacheEntry>();
  /** 手动覆盖的优先级（优先级最高） */
  private overrides = new Map<string, number>();

  private algorithmConfig: AlgorithmConfig;
  private defaultPriority: number;
  private cacheTtlMs: number;
  private onGetPriority?: OnGetPriority;

  constructor(options: PriorityStrategyOptions = {}) {
    this.algorithmConfig = options.algorithm ?? { type: 'weighted-random' };
    this.defaultPriority = options.defaultPriority ?? 1;
    this.cacheTtlMs = options.cacheTtlMs ?? 5000;
    this.onGetPriority = options.onGetPriority;
  }

  /**
   * 手动覆盖某个组的优先级（优先级高于 Redis 配置和 getPriority）
   * 主要用于测试或临时调整
   */
  setPriority(groupId: string, priority: number) {
    this.overrides.set(groupId, priority);
  }

  /**
   * 清除手动覆盖，恢复使用 Redis 配置或 getPriority
   */
  clearPriority(groupId: string) {
    this.overrides.delete(groupId);
  }

  /**
   * 获取组的基础优先级
   * 优先级来源顺序：overrides > cache > onGetPriority(config) 或 config.priority
   */
  private async resolvePriority(
    queue: Queue<any>,
    groupId: string,
  ): Promise<number> {
    // 1. 检查手动覆盖
    const override = this.overrides.get(groupId);
    if (override !== undefined) {
      return override;
    }

    // 2. 检查缓存是否有效
    const now = Date.now();
    const cached = this.cache.get(groupId);
    if (cached && cached.expiresAt > now) {
      return cached.priority;
    }

    // 3. 从 Redis 读取配置
    const config = await queue.getGroupConfig(groupId);

    // 4. 计算优先级：使用自定义函数或直接取 config.priority
    let priority: number;
    if (this.onGetPriority) {
      priority = await this.onGetPriority(groupId, config);
    } else {
      // 如果 config.priority 是默认值且用户设置了 defaultPriority，则使用 defaultPriority
      priority = config.priority !== 1 ? config.priority : this.defaultPriority;
    }

    // 5. 更新缓存
    if (this.cacheTtlMs > 0) {
      this.cache.set(groupId, {
        priority,
        expiresAt: now + this.cacheTtlMs,
      });
    }

    return priority;
  }

  /**
   * 严格优先级算法：总是返回优先级最高的组
   */
  private selectByStrict(groups: GroupPriorityInfo[]): string {
    groups.sort((a, b) => b.priority - a.priority);
    return groups[0].groupId;
  }

  /**
   * 加权随机算法：根据优先级计算概率选择
   * 使用 minWeightRatio 确保低优先级组也有机会
   */
  private selectByWeightedRandom(groups: GroupPriorityInfo[]): string {
    if (groups.length === 1) {
      return groups[0].groupId;
    }

    // 获取算法专属参数
    const config = this.algorithmConfig as WeightedRandomAlgorithmConfig;
    const minWeightRatio = config.minWeightRatio ?? 0.1;

    // 找出最大优先级
    const maxPriority = Math.max(...groups.map((g) => g.priority));

    // 计算每个组的权重，确保最低权重不低于 maxPriority * minWeightRatio
    const minWeight = maxPriority * minWeightRatio;
    const weights = groups.map((g) => ({
      groupId: g.groupId,
      weight: Math.max(g.priority, minWeight),
    }));

    // 计算总权重
    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

    // 加权随机选择
    let random = Math.random() * totalWeight;
    for (const w of weights) {
      random -= w.weight;
      if (random <= 0) {
        return w.groupId;
      }
    }

    // fallback
    return groups[0].groupId;
  }

  /**
   * 时间衰减算法：等待时间越长，优先级加成越高
   */
  private selectByAging(groups: GroupPriorityInfo[]): string {
    const now = Date.now();

    // 获取算法专属参数
    const config = this.algorithmConfig as AgingAlgorithmConfig;
    const intervalMs = config.intervalMs ?? 60000;

    // 计算带时间加成的优先级
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

    // 按调整后的优先级排序
    adjustedGroups.sort((a, b) => b.adjustedPriority - a.adjustedPriority);
    return adjustedGroups[0].groupId;
  }

  async getNextGroup(queue: Queue<any>): Promise<string | null> {
    // 1. 获取当前所有处于 Ready 状态的 Group
    const readyGroups = await queue.getReadyGroups(0, 100);

    if (readyGroups.length === 0) {
      return null;
    }

    // 2. 批量获取优先级信息
    const groupInfos: GroupPriorityInfo[] = await Promise.all(
      readyGroups.map(async (groupId) => {
        const priority = await this.resolvePriority(queue, groupId);
        const info: GroupPriorityInfo = { groupId, priority };

        // aging 算法需要获取最老任务的时间戳
        if (this.algorithmConfig.type === 'aging') {
          info.oldestTimestamp = await queue.getGroupOldestTimestamp(groupId);
        }

        return info;
      }),
    );

    // 3. 根据算法类型选择组
    switch (this.algorithmConfig.type) {
      case 'strict':
        return this.selectByStrict(groupInfos);
      case 'aging':
        return this.selectByAging(groupInfos);
      case 'weighted-random':
      default:
        return this.selectByWeightedRandom(groupInfos);
    }
  }
}
