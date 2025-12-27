import { DispatchStrategy } from './dispatch-strategy';
import type { Queue, ReservedJob } from '../queue';
import { GET_WEIGHTED_GROUPS_LUA } from './lua/get-weighted-groups';
import { GET_GROUPS_PROBABILITY_LUA } from './lua/get-weighted-groups-probability';
import { GET_GROUPS_AGING_LUA } from './lua/get-weighted-groups-aging';

// Lua 返回的数据结构
type LuaGroupResult = {
  id: string; // groupId
  p: number;  // priority
  ts: number; // oldest timestamp
};

// ==========================================
// 1. Client-Side Algorithms (Local Sorting)
//    负责：在 Worker 本地对候选列表进行重排，以解决并发冲突
// ==========================================

/** 严格排序：完全信任服务端的返回顺序 */
export type ClientStrictConfig = { type: 'strict' };

/** 加权随机（推荐）：根据优先级权重打散顺序，防止惊群 */
export type ClientWeightedRandomConfig = {
  type: 'weighted-random';
  /**
   * 最低权重比例 (0-1)
   * 用于防止低优先级组的被选中概率过低（接近于0）。
   * 
   * 逻辑：minWeight = maxPriority * minWeightRatio
   * 实际权重取 Math.max(priority, minWeight)
   * @example 0.1 // 如果最大优先级是10，则最低权重为1，保证低优任务也有一定概率被选中
   * @default 0.1
   */
  minWeightRatio?: number;
};

/** 时间衰减：客户端再次计算 Aging（通常不推荐与服务端 Virtual Aging 同时使用） */
export type ClientAgingConfig = {
  type: 'aging';
  /**
   * 衰减间隔 (ms)
   * 定义了时间的价值：每经过多少毫秒，任务的“计算优先级”增加 1 点。
   * 
   * 逻辑：Bonus = Floor(WaitTime / intervalMs)
   * 
   * @example 60000 // 每等待1分钟，优先级+1
   * @default 60000
   */
  intervalMs?: number;
};

export type ClientAlgorithmConfig =
  | ClientStrictConfig
  | ClientWeightedRandomConfig
  | ClientAgingConfig;


// ==========================================
// 2. Server-Side Algorithms (Lua Selection)
//    负责：从 Redis 海量数据中筛选出最佳候选集 (Top N)
// ==========================================

/** 基础方案：仅获取头部 (Top N) */
export type SelectionNoneConfig = { type: 'none' };

/** 方案一：概率打捞 (推荐) —— 兼顾吞吐量与防饥饿 */
export type SelectionProbabilityConfig = {
  type: 'probability';
  /** 
   * 头部保送比例 (0-1)，剩余比例从深层随机抽取
   * @default 0.8 
   */
  topPercent?: number;
  /** 
   * 扫描深度
   * @default 500 
   */
  scanDepth?: number;
};

/** 方案二：强制时间片轮转 (虚拟分) —— 追求绝对公平 */
export type SelectionVirtualAgingConfig = {
  type: 'virtual-aging';
  /** 
   * 优先级因子 (ms)
   * 1点优先级 = 多少毫秒的等待时间权益
   * @default 60000 
   */
  priorityFactor?: number;
  /** 
   * 扫描深度
   * @default 500 
   */
  scanDepth?: number;
};

export type SelectionAlgorithmConfig =
  | SelectionNoneConfig
  | SelectionProbabilityConfig
  | SelectionVirtualAgingConfig;


// ==========================================
// Strategy Options
// ==========================================

export interface PriorityStrategyOptions {
  /**
   * [核心算法] 服务端筛选策略
   * 决定如何从 Redis 中选出候选组（解决优先级与饥饿问题）
   * 
   * - `probability`: (推荐) 概率打捞，高性能且防饥饿
   * - `virtual-aging`: 时间片轮转，绝对公平，计算量稍大
   * - `none`: 仅取 Top N，可能导致长尾饥饿
   * 
   * @default { type: 'probability', topPercent: 0.8, scanDepth: 500 }
   */
  algorithm?: SelectionAlgorithmConfig;

  /**
   * [辅助算法] 客户端排序策略
   * 决定 Worker 拿到候选组后按什么顺序尝试（解决并发冲突问题）
   * 
   * - `weighted-random`: (推荐) 加权随机，能有效打散请求，防止惊群
   * - `strict`: 严格按照服务端返回的顺序执行
   * 
   * @default 'weighted-random' (auto-configured based on server algorithm)
   */
  clientAlgorithm?: ClientAlgorithmConfig;

  /** 
   * 默认优先级 (当 Redis 中无配置时)
   * @default 1 
   */
  defaultPriority?: number;

  /**
   * 空闲轮询间隔 (ms)
   * @default 50
   */
  pollInterval?: number;

  /**
   * 每次从 Redis 拉取的候选组数量
   * @default 100
   */
  fetchLimit?: number;
}

type GroupPriorityInfo = {
  groupId: string;
  priority: number;
  oldestTimestamp?: number;
};

/**
 * 基于优先级的调度策略 (Priority Based Dispatch Strategy)
 * 
 * 此策略利用组的优先级配置 (`priority`) 来决定任务的调度顺序。
 * 它可以处理高并发场景下的资源争抢，并提供多种防饥饿机制。
 * 
 * ### 核心概念：优先级 (Priority)
 * 优先级是一个整数（默认为 1），**数值越大代表优先级越高**。
 * 你可以通过 `queue.groups.setConfig(groupId, { priority: 10 })` 进行设置。
 * 
 * ### 优先级在两个阶段的作用：
 * 
 * 1. **服务端筛选阶段 (Server Selection)** - `options.algorithm`
 *    决定哪些组有资格从 Redis 中被“捞”出来进入候选名单。
 *    - 在 `probability` (概率打捞) 模式下：高优先级组更容易进入 Top N 列表，但低优先级组也有概率被选中。
 *    - 在 `virtual-aging` (虚拟分) 模式下：优先级被转化为“时间权益”（例如：1 优先级 = 60秒等待时间），与实际等待时间共同决定排名。
 *    - 在 `none` 模式下：严格筛选优先级最高的组，低优先级组可能永远无法进入候选名单。
 * 
 * 2. **客户端排序阶段 (Client Ordering)** - `options.clientAlgorithm`
 *    决定 Worker 拿到候选名单后，先尝试处理哪个组。
 *    - 在 `weighted-random` (加权随机) 模式下：优先级作为**权重**。优先级为 10 的组被选中的概率约为优先级为 1 的组的 10 倍。
 *    - 在 `strict` (严格) 模式下：优先级作为**排序键**。Worker 永远先尝试列表里优先级最高的组。
 * 
 * ---
 * 
 * @example
 * // 场景 A (推荐): 高吞吐 + 防饥饿
 * // 服务端：80% 资源给高优，20% 随机捞长尾；客户端：加权随机打散请求
 * new PriorityStrategy({
 *   algorithm: { type: 'probability', topPercent: 0.8 },
 *   clientAlgorithm: { type: 'weighted-random' }
 * });
 * 
 * @example
 * // 场景 B: 绝对公平 (时间片轮转)
 * // 服务端：计算 (优先级 * 1分钟 + 等待时间)；客户端：加权随机
 * new PriorityStrategy({
 *   algorithm: { type: 'virtual-aging', priorityFactor: 60000 },
 *   clientAlgorithm: { type: 'weighted-random' }
 * });
 */
export class PriorityStrategy implements DispatchStrategy {
  private serverAlgorithm: SelectionAlgorithmConfig;
  private clientAlgorithm: ClientAlgorithmConfig;
  private defaultPriority: number;
  private fetchLimit: number;
  public readonly idleInterval: number;

  constructor(options: PriorityStrategyOptions = {}) {
    // 1. 配置服务端核心算法 (Selection)
    this.serverAlgorithm = options.algorithm ?? {
      type: 'probability',
      topPercent: 0.8,
      scanDepth: 500
    };

    // 2. 配置客户端排序算法 (Ordering) - 智能默认值
    if (!options.clientAlgorithm) {
      if (this.serverAlgorithm.type === 'virtual-aging') {
        // 如果服务端已经做了 Aging 计算，客户端只需做轻微扰动防止惊群
        // 这里的 weighted-random 会基于服务端返回的顺序（隐含权重）进行打散
        this.clientAlgorithm = { type: 'weighted-random', minWeightRatio: 0.5 };
      } else {
        // 其他情况 (Probability / None)，加权随机是平衡负载的最佳选择
        this.clientAlgorithm = { type: 'weighted-random' };
      }
    } else {
      this.clientAlgorithm = options.clientAlgorithm;
    }

    // 警告：逻辑冗余检查
    if (this.serverAlgorithm.type === 'virtual-aging' && this.clientAlgorithm.type === 'aging') {
      console.warn("⚠️ [GroupMQ] Warning: Using 'aging' on client-side with 'virtual-aging' on server-side is redundant. Prefer 'weighted-random' or 'strict' for clientAlgorithm.");
    }

    this.defaultPriority = options.defaultPriority ?? 1;
    this.idleInterval = options.pollInterval ?? 50;
    this.fetchLimit = options.fetchLimit ?? 100;
  }

  /**
   * 获取下一个可执行的任务
   */
  async acquireJob(queue: Queue<any>): Promise<ReservedJob<any> | null> {
    let resultJson: string | null = null;

    // STEP 1: 服务端筛选 (Server Selection)
    if (this.serverAlgorithm.type === 'probability') {
      resultJson = await queue.redis.eval(
        GET_GROUPS_PROBABILITY_LUA,
        1,
        queue.namespace,
        String(this.fetchLimit),
        String(this.defaultPriority),
        String(this.serverAlgorithm.topPercent ?? 0.8),
        String(this.serverAlgorithm.scanDepth ?? 500)
      ) as string;
    }
    else if (this.serverAlgorithm.type === 'virtual-aging') {
      resultJson = await queue.redis.eval(
        GET_GROUPS_AGING_LUA,
        1,
        queue.namespace,
        String(this.fetchLimit),
        String(this.defaultPriority),
        String(Date.now()),
        String(this.serverAlgorithm.priorityFactor ?? 60000),
        String(this.serverAlgorithm.scanDepth ?? 500)
      ) as string;
    }
    else {
      // 'none' - 原始逻辑
      resultJson = await queue.redis.eval(
        GET_WEIGHTED_GROUPS_LUA,
        1,
        queue.namespace,
        String(this.fetchLimit),
        String(this.defaultPriority)
      ) as string;
    }

    const rawGroups: LuaGroupResult[] = resultJson ? JSON.parse(resultJson) : [];

    if (rawGroups.length === 0) {
      return null;
    }

    const groupInfos: GroupPriorityInfo[] = rawGroups.map((g) => ({
      groupId: g.id,
      priority: g.p,
      oldestTimestamp: g.ts > 0 ? g.ts : undefined,
    }));

    // STEP 2: 客户端排序 (Client Ordering)
    const sortedGroupIds = this.sortGroupsLocally(groupInfos);

    // STEP 3: 执行 (Execution)
    for (const groupId of sortedGroupIds) {
      const result = await queue.reserveAtomic(groupId);
      if (result.status === 'success') {
        return result.job;
      }
      // limit_exceeded or empty -> continue
    }

    return null;
  }

  /**
   * 本地排序分发
   */
  private sortGroupsLocally(groups: GroupPriorityInfo[]): string[] {
    switch (this.clientAlgorithm.type) {
      case 'strict':
        return this.sortByStrict(groups);
      case 'aging':
        return this.sortByAging(groups);
      case 'weighted-random':
      default:
        return this.sortByWeightedRandom(groups);
    }
  }

  private sortByStrict(groups: GroupPriorityInfo[]): string[] {
    // 降序排列
    const sorted = [...groups].sort((a, b) => b.priority - a.priority);
    return sorted.map((g) => g.groupId);
  }

  private sortByWeightedRandom(groups: GroupPriorityInfo[]): string[] {
    if (groups.length === 1) return [groups[0].groupId];

    const config = this.clientAlgorithm as ClientWeightedRandomConfig;
    const minWeightRatio = config.minWeightRatio ?? 0.1;

    // 找出最大优先级
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

      if (!selectedGroupId) {
        selectedGroupId = remainingEntries[0][0];
      }

      result.push(selectedGroupId);
      remaining.delete(selectedGroupId);
    }

    return result;
  }

  private sortByAging(groups: GroupPriorityInfo[]): string[] {
    const now = Date.now();
    const config = this.clientAlgorithm as ClientAgingConfig;
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

    adjustedGroups.sort((a, b) => b.adjustedPriority - a.adjustedPriority);
    return adjustedGroups.map((g) => g.groupId);
  }
}