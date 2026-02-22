import { buildApp } from './app';
import {
  checkDbHealth,
  createDbPool,
  createLogger,
  createTelegramDlqQueue,
  createTelegramQueue,
  createRedisConnection,
  consumeRateLimit,
  enqueueTelegramJob,
  getQueueCounts,
  listQueueJobs,
  listTelegramFeedbackByChat,
  listTelegramFlowCounters,
  listTelegramFlowDailyCounters,
  listTelegramReportsByChat,
  loadConfig,
  markTelegramUpdateProcessed,
  pingRedis,
  requeueDlqJob,
  runMigrations,
  setTelegramWebhook
} from '@bonchik/shared';

export const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('api');
  const pool = createDbPool(config.DATABASE_URL);
  await runMigrations(pool);
  const redis = createRedisConnection(config.REDIS_URL);
  const queue = createTelegramQueue(config.REDIS_URL);
  const dlqQueue = createTelegramDlqQueue(config.REDIS_URL);

  const app = buildApp({
    logger,
    adminApiKey: config.ADMIN_API_KEY,
    rateLimit: {
      checkWebhook: (clientKey) =>
        consumeRateLimit(redis, `ratelimit:webhook:${clientKey}`, 60, 60),
      checkAdmin: (clientKey) => consumeRateLimit(redis, `ratelimit:admin:${clientKey}`, 30, 60)
    },
    checks: {
      checkDb: () => checkDbHealth(pool),
      checkRedis: () => pingRedis(redis)
    },
    telegram: {
      webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
      enqueueMessage: async (payload) => {
        await enqueueTelegramJob(queue, payload);
      },
      markUpdateProcessed: (updateId) => markTelegramUpdateProcessed(pool, updateId),
      getQueueHealth: async () => ({
        main: await getQueueCounts(queue),
        dlq: await getQueueCounts(dlqQueue)
      }),
      getFailedJobs: async (limit) => listQueueJobs(queue, 'failed', limit),
      getDlqJobs: async (limit) => listQueueJobs(dlqQueue, 'waiting', limit),
      requeueDlqJob: async (jobId) => requeueDlqJob(dlqQueue, queue, jobId),
      getReportsByChat: (chatId, limit) => listTelegramReportsByChat(pool, chatId, limit),
      getFeedbackByChat: (chatId, limit) => listTelegramFeedbackByChat(pool, chatId, limit),
      getFlowCounters: () => listTelegramFlowCounters(pool),
      getFlowDailyCounters: (days) => listTelegramFlowDailyCounters(pool, days)
    }
  });

  app.addHook('onClose', async () => {
    await Promise.all([queue.close(), dlqQueue.close(), pool.end(), redis.quit()]);
  });

  try {
    await app.listen({
      port: config.PORT,
      host: '0.0.0.0'
    });

    try {
      await setTelegramWebhook({
        botToken: config.TELEGRAM_BOT_TOKEN,
        appUrl: config.APP_URL,
        secretToken: config.TELEGRAM_WEBHOOK_SECRET
      });
      logger.info({ appUrl: config.APP_URL }, 'Telegram webhook configured');
    } catch (error) {
      logger.warn({ err: error }, 'Telegram webhook configuration failed');
    }

    logger.info({ port: config.PORT }, 'API started');
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start API');
    await app.close();
    process.exit(1);
  }
};
