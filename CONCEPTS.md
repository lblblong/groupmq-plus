# GroupMQ Core Concepts (心智模型)

本文档描述了 GroupMQ 的核心设计理念、层级结构以及调度决策逻辑。

## 1. 核心层级结构 (Hierarchy)

系统由外向内分为三层：

1.  **Queue (队列)**
    *   Redis 中的命名空间 (Namespace)。
    *   所有 Group 的集合容器。
2.  **Group (分组)**
    *   **核心概念**：任务的物理隔离单元和并发控制的基本单位。
    *   Worker 不是直接取任务，而是先锁定 Group。
3.  **Job (任务)**
    *   实际执行的最小原子单元。

---

## 2. 调度决策模型 (Dispatching)

Worker 获取任务的过程分为两个决策维度：

### 维度一：组间调度 (Inter-Group)
*决定 Worker 接下来处理哪一个 Group？*

*   **默认模式 (Default)**:
    *   **策略**: FIFO (先来后到)。
    *   **逻辑**: 谁先有任务排队，谁先被处理。
*   **策略模式 (With Strategy)**:
    *   **策略**: 由 `DispatchStrategy` (如 RoundRobin, Priority) 决定。
    *   **逻辑**: 
        *   **RoundRobin**: 随机洗牌，保证多租户公平性。
        *   **Priority**: 根据 Group 的权重/优先级插队。

### 维度二：组内调度 (Intra-Group)
*选中 Group 后，先处理该 Group 里的哪个任务？*

*   **策略**: 严格基于 `orderMs` 排序。
*   **逻辑**:
    *   默认 `orderMs = Date.now()` -> **FIFO**。
    *   `orderMs` 小于当前时间 -> **插队/高优**。
    *   `orderMs` 大于当前时间 -> **延时任务**。

---

## 3. 并发控制模型 (Concurrency)

双层控制机制：

1.  **Worker 级并发**:
    *   限制**本机**同时处理的任务数 (Node.js 线程池/资源限制)。
2.  **Group 级并发**:
    *   限制**同一个 Group ID** 在**整个集群**中同时运行的任务数。
    *   *例*: Group A 限制并发为 1 (严格串行)，Group B 限制并发为 5 (并行加速)。

---

## 4. 总结

GroupMQ 是一个支持 **"组隔离"** 的队列系统。
Worker 通过 **"策略"** 决定先服务哪个组，一旦选中组，则严格按照 **"orderMs"** 顺序执行组内任务，同时受限于 **"Group 并发配置"**。