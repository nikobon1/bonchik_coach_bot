import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';

export const TELEGRAM_QUEUE = 'telegram-jobs';
export const TELEGRAM_DLQ_QUEUE = 'telegram-jobs-dlq';
const MAX_LIST_LIMIT = 100;

export type TelegramJobPayload = {
  updateId: number;
  chatId: number;
  userId: number;
  username?: string;
  text?: string;
  media?:
    | {
        kind: 'voice' | 'audio';
        fileId: string;
        mimeType?: string;
      }
    | undefined;
};

export type TelegramJobContext = {
  jobId: string;
  queue: string;
  attemptsMade: number;
};

export type TelegramDlqJobPayload = {
  originalJobId: string;
  originalQueue: string;
  attemptsMade: number;
  failedAt: string;
  errorMessage: string;
  payload: TelegramJobPayload;
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

export const createTelegramDlqQueue = (redisUrl: string) =>
  new Queue<TelegramDlqJobPayload>(TELEGRAM_DLQ_QUEUE, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      removeOnComplete: 5000,
      removeOnFail: false
    }
  });

export const enqueueTelegramJob = (queue: Queue<TelegramJobPayload>, payload: TelegramJobPayload) =>
  queue.add('incoming-message', payload);

export const enqueueTelegramDlqJob = (
  queue: Queue<TelegramDlqJobPayload>,
  payload: TelegramDlqJobPayload
) => queue.add('failed-message', payload);

export const getQueueCounts = async <T>(queue: Queue<T>) =>
  queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

export type QueueJobSnapshot<T> = {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason?: string;
  timestamp: number;
  data: T;
};

const normalizeLimit = (limit: number): number => Math.max(1, Math.min(MAX_LIST_LIMIT, limit));

export const listQueueJobs = async <T>(
  queue: Queue<T>,
  status: 'failed' | 'waiting' | 'delayed' | 'completed',
  limit = 20
): Promise<Array<QueueJobSnapshot<T>>> => {
  const safeLimit = normalizeLimit(limit);
  const jobs = await queue.getJobs([status], 0, safeLimit - 1, false);

  return jobs.map((job) => ({
    id: String(job.id ?? 'unknown'),
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    data: job.data
  }));
};

export const requeueDlqJob = async (
  dlqQueue: Queue<TelegramDlqJobPayload>,
  mainQueue: Queue<TelegramJobPayload>,
  jobId: string
): Promise<boolean> => {
  const job = await dlqQueue.getJob(jobId);
  if (!job) {
    return false;
  }

  await mainQueue.add('requeued-message', job.data.payload);
  await job.remove();
  return true;
};

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
