import { buildApp } from './app';
import {
  checkDbHealth,
  createDbPool,
  createLogger,
  createRedisConnection,
  loadConfig,
  pingRedis
} from '@bonchik/shared';

export const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('api');
  const pool = createDbPool(config.DATABASE_URL);
  const redis = createRedisConnection(config.REDIS_URL);

  const app = buildApp({
    logger,
    checks: {
      checkDb: () => checkDbHealth(pool),
      checkRedis: () => pingRedis(redis)
    }
  });

  app.addHook('onClose', async () => {
    await Promise.all([pool.end(), redis.quit()]);
  });

  try {
    await app.listen({
      port: config.PORT,
      host: '0.0.0.0'
    });
    logger.info({ port: config.PORT }, 'API started');
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start API');
    await app.close();
    process.exit(1);
  }
};