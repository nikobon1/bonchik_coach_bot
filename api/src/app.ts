import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

type HealthChecks = {
  checkDb: () => Promise<void>;
  checkRedis: () => Promise<void>;
};

type BuildAppOptions = {
  logger: FastifyBaseLogger;
  checks: HealthChecks;
};

export const buildApp = ({ logger, checks }: BuildAppOptions): FastifyInstance => {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', async (_request, reply) => {
    try {
      await Promise.all([checks.checkDb(), checks.checkRedis()]);
      return {
        status: 'ok',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      requestSafeLog(app, error);
      reply.code(503);
      return {
        status: 'degraded',
        timestamp: new Date().toISOString()
      };
    }
  });

  return app;
};

const requestSafeLog = (app: FastifyInstance, error: unknown): void => {
  app.log.error({ err: error }, 'Health check failed');
};
