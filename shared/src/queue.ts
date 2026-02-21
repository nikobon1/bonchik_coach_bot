import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';

export const TELEGRAM_QUEUE = 'telegram-jobs';

export type TelegramJobPayload = {
  chatId: number;
  userId: number;
  username?: string;
  text: string;
};

export type TelegramJobContext = {
  jobId: string;
  queue: string;
  attemptsMade: number;
};

export type TelegramJobProcessor = (payload: TelegramJobPayload, context: TelegramJobContext) => Promise<void>;

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

export const enqueueTelegramJob = (queue: Queue<TelegramJobPayload>, payload: TelegramJobPayload) =>
  queue.add('incoming-message', payload);

export const createTelegramWorker = (
  redisUrl: string,
  logger: pino.Logger,
  processor: TelegramJobProcessor
) =>
  new Worker<TelegramJobPayload>(
    TELEGRAM_QUEUE,
    async (job: Job<TelegramJobPayload>) => {
      const context: TelegramJobContext = {
        jobId: String(job.id ?? 'unknown'),
        queue: TELEGRAM_QUEUE,
        attemptsMade: job.attemptsMade
      };

      logger.info(
        {
          ...context,
          chatId: job.data.chatId,
          userId: job.data.userId
        },
        'Processing telegram job'
      );

      await processor(job.data, context);
    },
    {
      connection: { url: redisUrl },
      concurrency: 10
    }
  );
