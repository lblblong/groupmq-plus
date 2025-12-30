import { describe, expect, test } from '../../helpers/suite';
import { RoundRobinStrategy } from '../../../src';

describe('RoundRobinStrategy', () => {
  test('should randomly select groups (distribution check)', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    const groupCount = 10;
    const groups: string[] = [];

    for (let i = 0; i < groupCount; i++) {
      const groupId = `group-${i}`;
      groups.push(groupId);
      await queue.add({ groupId, data: { id: i } });
    }

    const processedGroups: string[] = [];

    const worker = createWorker({
      queue,
      concurrency: 1,
      strategy: new RoundRobinStrategy({
        batchSize: 20,
      }),
      handler: async (job) => {
        processedGroups.push(job.groupId);
      },
    });

    worker.run();
    await queue.waitForEmpty();

    expect(processedGroups.length).toBe(groupCount);

    const isPerfectlySequential = processedGroups.every(
      (g, i) => g === `group-${i}`
    );

    console.log('Processed Order:', processedGroups.join(', '));
    expect(isPerfectlySequential).toBe(false);
  });

  test('should skip groups that have reached concurrency limit', async ({ createQueue, createWorker }) => {
    const queue = createQueue();

    await queue.groups.setConfig('group-limited', { concurrency: 1 });
    await queue.groups.setConfig('group-free', { concurrency: 10 });

    await queue.add({
      groupId: 'group-limited',
      data: { id: 'blocker', duration: 300 }
    });
    await queue.add({
      groupId: 'group-limited',
      data: { id: 'blocked' }
    });
    await queue.add({
      groupId: 'group-free',
      data: { id: 'free' }
    });

    const processed: string[] = [];

    const worker = createWorker({
      queue,
      concurrency: 5,
      strategy: new RoundRobinStrategy(),
      handler: async (job) => {
        if (job.data.duration) {
          await new Promise(r => setTimeout(r, job.data.duration));
        }
        processed.push(job.data.id);
      }
    });

    worker.run();

    await new Promise(r => setTimeout(r, 200));

    expect(processed).toContain('free');
    expect(processed).not.toContain('blocked');

    await queue.waitForEmpty();
  });
});
