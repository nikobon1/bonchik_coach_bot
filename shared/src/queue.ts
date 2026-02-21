import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';

export const TELEGRAM_QUEUE = 'telegram-jobs';

export type TelegramJobPayload = {
  chatId: number;
  text: string;
};

export const createTelegramQueue = (redisUrl: string) =>
  new Queue<TelegramJobPayload>(TELEGRAM_QUEUE, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      removeOnComplete: 1000,
      removeOnFail: 1000,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    }
  });

export const createTelegramWorker = (redisUrl: string, logger: pino.Logger) =>
  new Worker<TelegramJobPayload>(
    TELEGRAM_QUEUE,
    async (job: Job<TelegramJobPayload>) => {
      logger.info({ jobId: job.id, queue: TELEGRAM_QUEUE }, 'Processing telegram job');
    },
    {
      connection: { url: redisUrl },
      concurrency: 10
    }
  );
