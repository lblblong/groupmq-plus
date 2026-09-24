import { describe, expect, test } from '../helpers/suite'

describe('运行时调整 maxAttempts (changeMaxAttempts)', () => {
  test('处理中抬高上限后应继续重试直至新预算用尽', async ({ createQueue, createWorker }) => {
    const q = createQueue({ maxAttempts: 3 })

    await q.add({
      groupId: 'bump-group',
      data: { tag: 'dynamic' },
      maxAttempts: 2,
    })

    let runs = 0

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 0.1,
      schedulerIntervalMs: 50,
      backoff: () => 5,
      handler: async (job) => {
        runs++
        if (runs === 1) {
          await job.changeMaxAttempts(4)
        }
        if (runs < 4) {
          throw new Error(`fail run ${runs}`)
        }
      },
    })

    worker.run()
    await q.waitForEmpty()

    expect(runs).toBe(4)
  })

  test('顶到旧上限的这一轮里抬高，Worker 仍按新预算重试', async ({ createQueue, createWorker }) => {
    const q = createQueue({ maxAttempts: 3 })

    await q.add({
      groupId: 'bump-on-last',
      data: { tag: 'last' },
      maxAttempts: 2,
    })

    let runs = 0

    const worker = createWorker({
      queue: q,
      blockingTimeoutSec: 0.1,
      schedulerIntervalMs: 50,
      backoff: () => 5,
      handler: async (job) => {
        runs++
        if (runs === 2) {
          await job.changeMaxAttempts(4)
        }
        if (runs < 4) {
          throw new Error(`fail run ${runs}`)
        }
      },
    })

    worker.run()
    await q.waitForEmpty()

    expect(runs).toBe(4)
  })
})
