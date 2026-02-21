import { createLogger, createTelegramWorker, loadConfig } from '@bonchik/shared';

const startWorker = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('worker');
  const worker = createTelegramWorker(config.REDIS_URL, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.info('Worker started and waiting for jobs');
};

void startWorker();
