import { buildApp } from './app';
import {
  checkDbHealth,
  createDbPool,
  createLogger,
  createTelegramQueue,
  createRedisConnection,
  enqueueTelegramJob,
  loadConfig,
  pingRedis,
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

  const app = buildApp({
    logger,
    checks: {
      checkDb: () => checkDbHealth(pool),
      checkRedis: () => pingRedis(redis)
    },
    telegram: {
      enqueueMessage: async (payload) => {
        await enqueueTelegramJob(queue, payload);
      }
    }
  });

  app.addHook('onClose', async () => {
    await Promise.all([queue.close(), pool.end(), redis.quit()]);
  });

  try {
    await app.listen({
      port: config.PORT,
      host: '0.0.0.0'
    });

    try {
      await setTelegramWebhook({
        botToken: config.TELEGRAM_BOT_TOKEN,
        appUrl: config.APP_URL
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
