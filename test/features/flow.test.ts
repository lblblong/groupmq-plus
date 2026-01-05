import { describe, expect, test, waitUntil } from '../helpers/suite';
import { PriorityStrategy } from '../../src';

describe('Flow API (任务流方法)', () => {
  describe('parentId 属性', () => {
    test('应该为子任务设置 parentId', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-with-children';
      const childId = 'child-job-1';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      });

      const childJob = await queue.getJob(childId);
      expect(childJob.parentId).toBe(parentId);
    });

    test('应该为非子任务设置 undefined parentId', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      expect(job.parentId).toBeUndefined();
    });

    test('应该为父任务设置 undefined parentId', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-job';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [{ groupId: 'g-child', data: { name: 'child' } }],
      });

      const parentJob = await queue.getJob(parentId);
      expect(parentJob.parentId).toBeUndefined();
    });
  });

  describe('getChildren()', () => {
    test('应该返回父任务的所有子任务', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-get-children';
      const child1Id = 'child-gc-1';
      const child2Id = 'child-gc-2';

      const parentJob = await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
          { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
        ],
      });

      const children = await parentJob.getChildren();

      expect(children).toHaveLength(2);
      const childIds = children.map((c) => c.id).sort();
      expect(childIds).toEqual([child1Id, child2Id].sort());
    });

    test('应该为没有子任务的任务返回空数组', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      const children = await job.getChildren();

      expect(children).toEqual([]);
    });

    test('应该优雅地跳过已删除的子任务', async ({ redis, namespace, createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-deleted-child';
      const child1Id = 'child-to-delete';
      const child2Id = 'child-to-keep';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
          { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
        ],
      });

      // 直接从 Redis 删除一个子任务（模拟清理）
      await redis.del(`groupmq:${namespace}:job:${child1Id}`);

      const parentJob = await queue.getJob(parentId);
      const children = await parentJob.getChildren();

      // 应该只返回剩余的子任务
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child2Id);
    });
  });

  describe('getChildrenValues()', () => {
    test('应该返回子任务的执行结果', async ({ createQueue, createWorker }) => {
      const queue = createQueue();

      const parentId = 'parent-values';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: 'child-v-1', groupId: 'g-child-1', data: { value: 10 } },
          { jobId: 'child-v-2', groupId: 'g-child-2', data: { value: 20 } },
        ],
      });

      const worker = createWorker({
        queue,
        handler: async (job) => {
          if (job.data.value) {
            return { computed: job.data.value * 2 };
          }
          return 'parent-done';
        },
      });
      worker.run();

      // 使用状态轮询等待父任务完成
      await waitUntil(async () => {
        const job = await queue.getJob(parentId);
        return job.status === 'completed';
      }, 5000);

      const parentJob = await queue.getJob(parentId);
      const values = await parentJob.getChildrenValues();

      expect(values.find((v) => v.jobId === 'child-v-1')?.result).toEqual({
        computed: 20,
      });
      expect(values.find((v) => v.jobId === 'child-v-2')?.result).toEqual({
        computed: 40,
      });
    });

    test('应该为没有子任务的任务返回空对象', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      const values = await job.getChildrenValues();

      expect(values).toEqual([]);
    });
  });

  describe('getRemainingCount()', () => {
    test('应该返回剩余子任务的正确数量', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-deps';

      const parentJob = await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          {
            jobId: 'child-d-1',
            groupId: 'g-child-1',
            data: { name: 'child1' },
          },
          {
            jobId: 'child-d-2',
            groupId: 'g-child-2',
            data: { name: 'child2' },
          },
          {
            jobId: 'child-d-3',
            groupId: 'g-child-3',
            data: { name: 'child3' },
          },
        ],
      });

      const count = await parentJob.getRemainingCount();

      expect(count).toBe(3);
    });

    test('应该为非父任务返回 null', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      const count = await job.getRemainingCount();

      expect(count).toBeNull();
    });
  });

  describe('getParent()', () => {
    test('应该为子任务返回父任务', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-for-getparent';
      const childId = 'child-for-getparent';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      });

      const childJob = await queue.getJob(childId);
      const parent = await childJob.getParent();

      expect(parent).toBeDefined();
      expect(parent!.id).toBe(parentId);
      expect(parent!.data).toEqual({ name: 'parent' });
    });

    test('应该为没有父任务的任务返回 undefined', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      const parent = await job.getParent();

      expect(parent).toBeUndefined();
    });

    test('应该在父任务被删除时返回 undefined', async ({ redis, namespace, createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-to-delete';
      const childId = 'child-orphan';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: childId, groupId: 'g-child', data: { name: 'child' } },
        ],
      });

      // 直接从 Redis 删除父任务
      await redis.del(`groupmq:${namespace}:job:${parentId}`);

      const childJob = await queue.getJob(childId);
      const parent = await childJob.getParent();

      expect(parent).toBeUndefined();
    });
  });

  describe('Queue.getFlowChildrenIds()', () => {
    test('应该返回父任务的所有子任务 ID', async ({ createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-ids';
      const child1Id = 'child-id-1';
      const child2Id = 'child-id-2';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
          { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
        ],
      });

      const ids = await queue.getFlowChildrenIds(parentId);

      expect(ids).toHaveLength(2);
      expect(ids.sort()).toEqual([child1Id, child2Id].sort());
    });

    test('应该为非父任务返回空数组', async ({ createQueue }) => {
      const queue = createQueue();

      const job = await queue.add({ groupId: 'g1', data: { test: true } });
      const ids = await queue.getFlowChildrenIds(job.id);

      expect(ids).toEqual([]);
    });
  });

  describe('任务流移除时的清理', () => {
    test('应该在父任务被移除时清理子任务集合', async ({ redis, namespace, createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-cleanup';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          {
            jobId: 'child-cleanup-1',
            groupId: 'g-child',
            data: { name: 'child' },
          },
        ],
      });

      // 验证子任务集合存在
      const childrenKey = `groupmq:${namespace}:flow:children:${parentId}`;
      let exists = await redis.exists(childrenKey);
      expect(exists).toBe(1);

      // 移除父任务
      const parentJob = await queue.getJob(parentId);
      await parentJob.remove();

      // 验证子任务集合被删除
      exists = await redis.exists(childrenKey);
      expect(exists).toBe(0);
    });

    test('应该在子任务被移除时从父任务的子任务集合中移除子任务', async ({ redis, namespace, createQueue }) => {
      const queue = createQueue();

      const parentId = 'parent-child-cleanup';
      const child1Id = 'child-to-remove';
      const child2Id = 'child-to-keep';

      await queue.addFlow({
        parent: {
          jobId: parentId,
          groupId: 'g-parent',
          data: { name: 'parent' },
        },
        children: [
          { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
          { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
        ],
      });

      // 验证两个子任务都在集合中
      const childrenKey = `groupmq:${namespace}:flow:children:${parentId}`;
      let members = await redis.smembers(childrenKey);
      expect(members.sort()).toEqual([child1Id, child2Id].sort());

      // 移除一个子任务
      const childJob = await queue.getJob(child1Id);
      await childJob.remove();

      // 验证只有一个子任务保留
      members = await redis.smembers(childrenKey);
      expect(members).toEqual([child2Id]);
    });
  });
});

describe('Flow 执行 (父子任务流)', () => {
  test('应该在所有子任务完成后才处理父任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ logger: true });

    const parentId = 'parent-1';
    const child1Id = 'child-1';
    const child2Id = 'child-2';

    const parent = await queue.addFlow({
      parent: {
        jobId: parentId,
        groupId: 'g-parent',
        data: { name: 'parent' },
      },
      children: [
        { jobId: child1Id, groupId: 'g-child-1', data: { name: 'child1' } },
        { jobId: child2Id, groupId: 'g-child-2', data: { name: 'child2' } },
      ],
    });

    // 检查初始状态
    expect(parent.status).toBe('waiting-children');

    const remaining = await queue.getFlowRemainingCount(parentId);
    expect(remaining).toBe(2);

    const worker = createWorker({
      queue,
      logger: true,
      handler: async (job) => {
        console.log('Processing job:', job.id);
      },
    });
    worker.run();

    // 等待父任务完成（这意味着所有子任务也完成了）
    await parent.waitUntilFinished(5000);

    // 验证所有任务都完成了
    expect((await queue.getJob(child1Id)).status).toBe('completed');
    expect((await queue.getJob(child2Id)).status).toBe('completed');
    expect((await queue.getJob(parentId)).status).toBe('completed');
    expect(await queue.getFlowRemainingCount(parentId)).toBe(0);
  });

  test('应该在子任务完全失败时触发父任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ logger: false });

    // 添加 Flow：1个子任务必然失败
    const parent = await queue.addFlow({
      parent: { groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { groupId: 'c-g', data: { fail: true }, maxAttempts: 1 },
        { groupId: 'c-g', data: { fail: false } },
      ],
    });

    const completedJobs: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        if (job.data.fail) {
          throw new Error('Planned failure');
        }
        completedJobs.push(job.id);
        return 'ok';
      },
    });
    worker.run();

    // 使用 waitUntilFinished 等待父任务完成
    await parent.waitUntilFinished(5000);

    // 验证：父任务是否进入了 Completed 状态
    const processedParent = completedJobs.find((id) => id.length > 10);
    expect(processedParent).toBeDefined();
  });

  test('应该通过 getFlowResults 存储和检索子任务结果', async ({ createQueue, createWorker }) => {
    const queue = createQueue({ logger: false });

    const parentId = 'parent-results';

    const parent = await queue.addFlow({
      parent: { jobId: parentId, groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { jobId: 'child-a', groupId: 'c-g', data: { value: 10 } },
        { jobId: 'child-b', groupId: 'c-g', data: { value: 20 } },
      ],
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        if (job.data.value) {
          return { computed: job.data.value * 2 };
        }
        const results = await queue.getFlowResults(job.id);
        return { childResults: results };
      },
    });
    worker.run();

    // 使用 waitUntilFinished 等待父任务完成
    await parent.waitUntilFinished(5000);

    // 验证子任务结果被正确存储
    const flowResults = await queue.getFlowResults(parentId);
    expect(flowResults.find((r) => r.jobId === 'child-a')?.result).toEqual({
      computed: 20,
    });
    expect(flowResults.find((r) => r.jobId === 'child-b')?.result).toEqual({
      computed: 40,
    });
  });

  test('应该在子任务进入死信队列时触发父任务', async ({ createQueue, createWorker }) => {
    const queue = createQueue({
      logger: false,
      keepFailed: 10,
    });

    const parentId = 'parent-dl';

    const parentJob = await queue.addFlow({
      parent: { jobId: parentId, groupId: 'p-g', data: { name: 'parent' } },
      children: [
        { jobId: 'child-ok', groupId: 'c-g-ok', data: { fail: false } },
        {
          jobId: 'child-fail',
          groupId: 'c-g-fail',
          data: { fail: true },
          maxAttempts: 1,
        },
      ],
    });

    const processedJobs: string[] = [];

    const worker = createWorker({
      queue,
      handler: async (job) => {
        if (job.data.fail) {
          throw new Error('Intentional failure');
        }
        processedJobs.push(job.id);
        return 'success';
      },
    });

    await parentJob.waitUntilFinished();

    // 验证父任务被触发执行了
    expect(processedJobs).toContain(parentId);

    // 验证 flowResults 包含结果
    const flowResults = await parentJob.getChildrenValues();
    expect(flowResults.find((r) => r.jobId === 'child-ok')?.result).toBe(
      'success'
    );
    expect(
      flowResults.find((r) => r.jobId === 'child-fail')?.result
    ).toBeDefined();
  });

  test('父子任务均失败', async ({ createQueue, createWorker }) => {
    let finalFailedJobs: string[] = [];

    const queue = createQueue({
      keepFailed: 10,
      maxAttempts: 2,
    });

    const parent = await queue.addFlow({
      parent: {
        jobId: 'parent-job',
        groupId: 'g-parent',
        data: { name: 'parent' },
      },
      children: [
        {
          jobId: 'child-job-1',
          groupId: 'g-child-1',
          data: { name: 'child1' },
        },
        {
          jobId: 'child-job-2',
          groupId: 'g-child-2',
          data: { name: 'child2' },
        },
      ],
    });

    const worker = createWorker({
      queue,
      handler: async (job) => {
        if (job.isFlowParent) {
          throw new Error(`Parent job ${job.id} failed intentionally`);
        } else {
          throw new Error(`Child job ${job.id} failed intentionally`);
        }
      },
    });
    worker.on('completed', (job) => {
      console.log(`[COMPLETED] ${job.name}-${job.id}`);
    });
    worker.on('failed', async (job) => {
      const isFinalFailure = job.attemptsMade >= job.opts.attempts - 1;
      if (isFinalFailure) {
        console.error(
          `[FINAL FAILED] ${job.name}-${job.id}: ${job.failedReason}`
        );
        finalFailedJobs.push(job.id);
      } else {
        console.log(`[FAILED] ${job.name}-${job.id}: ${job.failedReason}`);
      }
    });

    try {
      await parent.waitUntilFinished();
    } catch (err) {
      console.log(err);
    }

    // 使用状态轮询等待所有任务进入最终失败状态
    await waitUntil(async () => finalFailedJobs.length >= 3, 5000);

    expect(finalFailedJobs).toContain('parent-job');
    expect(finalFailedJobs).toContain('child-job-1');
    expect(finalFailedJobs).toContain('child-job-2');
  });

  test('应该对流中的父任务和子任务应用 groupConfig', async ({ createQueue }) => {
    const queue = createQueue({ logger: false });

    const parentGroupId = 'flow-parent-group';
    const child1GroupId = 'flow-child-group-1';
    const child2GroupId = 'flow-child-group-2';

    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: { priority: 100, concurrency: 5 },
      },
      children: [
        {
          groupId: child1GroupId,
          data: { name: 'child1' },
          groupConfig: { priority: 50, concurrency: 2 },
        },
        {
          groupId: child2GroupId,
          data: { name: 'child2' },
          groupConfig: { priority: 75, concurrency: 3 },
        },
      ],
    });

    // 验证父任务的 groupConfig 被设置
    const parentConfig = await queue.groups.getConfig(parentGroupId);
    expect(parentConfig.priority).toBe(100);
    expect(parentConfig.concurrency).toBe(5);

    // 验证子任务1的 groupConfig 被设置
    const child1Config = await queue.groups.getConfig(child1GroupId);
    expect(child1Config.priority).toBe(50);
    expect(child1Config.concurrency).toBe(2);

    // 验证子任务2的 groupConfig 被设置
    const child2Config = await queue.groups.getConfig(child2GroupId);
    expect(child2Config.priority).toBe(75);
    expect(child2Config.concurrency).toBe(3);

    // 验证流与 groupConfigs 正确协作
    expect(parent.status).toBe('waiting-children');
    const remaining = await queue.getFlowRemainingCount(parent.id);
    expect(remaining).toBe(2);
  });

  test('应该处理部分 groupConfig 的流（仅父任务）', async ({ createQueue }) => {
    const queue = createQueue({ logger: false });

    const parentGroupId = 'partial-parent-group';
    const childGroupId = 'partial-child-group';

    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: { priority: 90 },
      },
      children: [
        {
          groupId: childGroupId,
          data: { name: 'child' },
        },
      ],
    });

    // 验证父任务的 config 被设置
    const parentConfig = await queue.groups.getConfig(parentGroupId);
    expect(parentConfig.priority).toBe(90);

    // 子任务的 groupConfig 应该存在但不包含特殊配置
    const childConfig = await queue.groups.getConfig(childGroupId);
    expect(childConfig.priority).toBeUndefined();
  });

  test('应该支持自定义 groupConfig 属性，如 weight', async ({ createQueue }) => {
    const queue = createQueue({ logger: false });

    const parentGroupId = 'custom-parent-group';
    const child1GroupId = 'custom-child-group-1';
    const child2GroupId = 'custom-child-group-2';

    const parent = await queue.addFlow({
      parent: {
        groupId: parentGroupId,
        data: { name: 'parent' },
        groupConfig: {
          priority: 100,
          concurrency: 5,
          weight: 10,
          customField: 'custom-value',
        },
      },
      children: [
        {
          groupId: child1GroupId,
          data: { name: 'child1' },
          groupConfig: {
            priority: 50,
            concurrency: 2,
            weight: 5,
          },
        },
        {
          groupId: child2GroupId,
          data: { name: 'child2' },
          groupConfig: {
            priority: 75,
            concurrency: 3,
            weight: 8,
            routingKey: 'route-key',
          },
        },
      ],
    });

    // 验证父任务的 config 包括自定义属性
    const parentConfig = await queue.groups.getConfig(parentGroupId);
    expect(parentConfig.priority).toBe(100);
    expect(parentConfig.concurrency).toBe(5);
    expect(parentConfig.weight).toBe(10);
    expect(parentConfig.customField).toBe('custom-value');

    // 验证子任务1的 config 包括自定义属性
    const child1Config = await queue.groups.getConfig(child1GroupId);
    expect(child1Config.priority).toBe(50);
    expect(child1Config.concurrency).toBe(2);
    expect(child1Config.weight).toBe(5);

    // 验证子任务2的 config 包括多个自定义属性
    const child2Config = await queue.groups.getConfig(child2GroupId);
    expect(child2Config.priority).toBe(75);
    expect(child2Config.concurrency).toBe(3);
    expect(child2Config.weight).toBe(8);
    expect(child2Config.routingKey).toBe('route-key');

    // 验证流与自定义 configs 正确协作
    expect(parent.status).toBe('waiting-children');
    const remaining = await queue.getFlowRemainingCount(parent.id);
    expect(remaining).toBe(2);
  });
});

describe('Flow 错误处理 (任务流重试)', () => {
  test('确保父任务在子任务重试时依然在所有子任务结束时执行', async ({ createQueue, createWorker }) => {
    let execHistory: string[] = [];

    const queue = createQueue({
      keepFailed: 10,
      maxAttempts: 2,
    });

    const parent = await queue.addFlow({
      parent: {
        jobId: 'parent-job',
        groupId: 'g-parent',
        data: { name: 'parent' },
        groupConfig: { priority: 10000 },
      },
      children: [
        {
          jobId: 'child-job-1',
          groupId: 'g-child-1',
          data: { name: 'child1' },
          groupConfig: { priority: 10 },
        },
        {
          jobId: 'child-job-2',
          groupId: 'g-child-2',
          data: { name: 'child2' },
          groupConfig: { priority: 10 },
        },
      ],
    });

    const worker = createWorker({
      queue,
      concurrency: 1,
      strategy: new PriorityStrategy(),
      backoff: () => 300,
      handler: async (job) => {
        execHistory.push(job.id);
        if (job.isFlowParent) {
          throw new Error(`Parent job ${job.id} failed intentionally`);
        } else {
          throw new Error(`Child job ${job.id} failed intentionally`);
        }
      },
    });

    try {
      await parent.waitUntilFinished();
    } catch (err) {
      console.log(err);
    }

    expect(execHistory).toHaveLength(6);
    expect(execHistory.slice(-2)).toEqual(['parent-job', 'parent-job']);
  }, 5000);
});
