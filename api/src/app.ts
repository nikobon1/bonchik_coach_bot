import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';

type HealthChecks = {
  checkDb: () => Promise<void>;
  checkRedis: () => Promise<void>;
};

type BuildAppOptions = {
  logger: FastifyBaseLogger;
  checks: HealthChecks;
  adminApiKey?: string;
  telegram: {
    enqueueMessage: (payload: TelegramMessagePayload) => Promise<void>;
    getQueueHealth: () => Promise<{
      main: Record<string, number>;
      dlq: Record<string, number>;
    }>;
    getFailedJobs: (limit?: number) => Promise<unknown[]>;
    getDlqJobs: (limit?: number) => Promise<unknown[]>;
    requeueDlqJob: (jobId: string) => Promise<boolean>;
  };
};

type TelegramMessagePayload = {
  chatId: number;
  userId: number;
  username?: string;
  text: string;
};

const telegramUpdateSchema = z.object({
  message: z
    .object({
      text: z.string().min(1),
      chat: z.object({
        id: z.number()
      }),
      from: z.object({
        id: z.number(),
        username: z.string().optional()
      })
    })
    .optional()
});

const adminListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20)
});

const requeueParamsSchema = z.object({
  jobId: z.string().min(1)
});

export const buildApp = ({ logger, checks, telegram, adminApiKey }: BuildAppOptions): FastifyInstance => {
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

  app.post('/telegram/webhook', async (request) => {
    const parsed = telegramUpdateSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.message) {
      return { ok: true, skipped: true };
    }

    await telegram.enqueueMessage({
      chatId: parsed.data.message.chat.id,
      userId: parsed.data.message.from.id,
      username: parsed.data.message.from.username,
      text: parsed.data.message.text
    });

    return { ok: true };
  });

  app.get('/admin/queue/health', async (request, reply) => {
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    return {
      ok: true,
      queues: await telegram.getQueueHealth()
    };
  });

  app.get('/admin/queue/failed', async (request, reply) => {
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const query = adminListQuerySchema.parse(request.query);
    return {
      ok: true,
      jobs: await telegram.getFailedJobs(query.limit)
    };
  });

  app.get('/admin/queue/dlq', async (request, reply) => {
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const query = adminListQuerySchema.parse(request.query);
    return {
      ok: true,
      jobs: await telegram.getDlqJobs(query.limit)
    };
  });

  app.post('/admin/queue/dlq/requeue/:jobId', async (request, reply) => {
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const params = requeueParamsSchema.parse(request.params);
    const moved = await telegram.requeueDlqJob(params.jobId);
    if (!moved) {
      reply.code(404);
      return { ok: false };
    }
    return { ok: true, jobId: params.jobId };
  });

  return app;
};

const requestSafeLog = (app: FastifyInstance, error: unknown): void => {
  app.log.error({ err: error }, 'Health check failed');
};

const isAdminAuthorized = (headerValue: string | string[] | undefined, adminApiKey?: string): boolean => {
  if (!adminApiKey) {
    return false;
  }
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return token === adminApiKey;
};
