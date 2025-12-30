import pino from 'pino';
import { describe, expect, test } from '../helpers/suite';
import winston from 'winston';

describe('日志记录器 (logger)', () => {
  test('应当支持 pino 日志记录器 (pino)', async ({ createQueue, createWorker }) => {
    const logger = pino();
    const queue = createQueue({ jobTimeoutMs: 5000 });
    const worker = createWorker({
      logger,
      queue,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.run();
  });

  test('应当支持 winston 日志记录器 (winston)', async ({ createQueue, createWorker }) => {
    const logger = winston.createLogger();
    const queue = createQueue({ jobTimeoutMs: 5000 });
    const worker = createWorker({
      logger,
      queue,
      handler: async () => {
        return 'return value from worker';
      },
    });
    worker.run();
  });
});
