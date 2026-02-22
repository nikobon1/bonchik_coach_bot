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
  rateLimit: {
    checkWebhook: (clientKey: string) => Promise<{ allowed: boolean; retryAfterSec: number }>;
    checkAdmin: (clientKey: string) => Promise<{ allowed: boolean; retryAfterSec: number }>;
  };
  telegram: {
    webhookSecret?: string;
    enqueueMessage: (payload: TelegramMessagePayload) => Promise<void>;
    markUpdateProcessed: (updateId: number) => Promise<boolean>;
    getQueueHealth: () => Promise<{
      main: Record<string, number>;
      dlq: Record<string, number>;
    }>;
    getFailedJobs: (limit?: number) => Promise<unknown[]>;
    getDlqJobs: (limit?: number) => Promise<unknown[]>;
    requeueDlqJob: (jobId: string) => Promise<boolean>;
    getReportsByChat: (chatId: number, limit?: number) => Promise<unknown[]>;
    getFeedbackByChat: (chatId: number, limit?: number) => Promise<unknown[]>;
    getFlowCounters: () => Promise<unknown[]>;
    getFlowDailyCounters: (days?: number) => Promise<unknown[]>;
  };
};

type TelegramMessagePayload = {
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

const FLOW_COUNTER_KEYS = [
  'feedback_started',
  'feedback_saved',
  'feedback_cancelled',
  'mode_recommendation_started',
  'mode_recommendation_suggested',
  'mode_recommendation_cancelled'
] as const;

type FlowCounterKey = (typeof FLOW_COUNTER_KEYS)[number];

type FlowCounterRow = {
  key: FlowCounterKey;
  value: number;
  updatedAt?: string;
};

type FlowDailyCounterRow = {
  date: string;
  key: FlowCounterKey;
  value: number;
};

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      text: z.string().min(1).optional(),
      voice: z
        .object({
          file_id: z.string().min(1),
          mime_type: z.string().optional()
        })
        .optional(),
      audio: z
        .object({
          file_id: z.string().min(1),
          mime_type: z.string().optional()
        })
        .optional(),
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

const reportsParamsSchema = z.object({
  chatId: z.coerce.number().int()
});

const adminAnalyticsDaysQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).default(14)
});

export const buildApp = ({ logger, checks, telegram, adminApiKey, rateLimit }: BuildAppOptions): FastifyInstance => {
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

  app.post('/telegram/webhook', async (request, reply) => {
    const webhookRate = await rateLimit.checkWebhook(getClientKey(request.headers['x-forwarded-for'], request.ip));
    if (!webhookRate.allowed) {
      reply.code(429);
      return {
        ok: false,
        error: 'rate_limited',
        retryAfterSec: webhookRate.retryAfterSec
      };
    }

    if (!isWebhookAuthorized(request.headers['x-telegram-bot-api-secret-token'], telegram.webhookSecret)) {
      return { ok: true, skipped: true };
    }

    const parsed = telegramUpdateSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.message) {
      return { ok: true, skipped: true };
    }
    if (!parsed.data.message.text && !parsed.data.message.voice && !parsed.data.message.audio) {
      return { ok: true, skipped: true };
    }

    const isNewUpdate = await telegram.markUpdateProcessed(parsed.data.update_id);
    if (!isNewUpdate) {
      return { ok: true, duplicate: true };
    }

    const media = parsed.data.message.voice
      ? {
          kind: 'voice' as const,
          fileId: parsed.data.message.voice.file_id,
          mimeType: parsed.data.message.voice.mime_type
        }
      : parsed.data.message.audio
        ? {
            kind: 'audio' as const,
            fileId: parsed.data.message.audio.file_id,
            mimeType: parsed.data.message.audio.mime_type
          }
        : undefined;

    await telegram.enqueueMessage({
      updateId: parsed.data.update_id,
      chatId: parsed.data.message.chat.id,
      userId: parsed.data.message.from.id,
      username: parsed.data.message.from.username,
      text: parsed.data.message.text,
      media
    });

    return { ok: true };
  });

  app.get('/admin/queue/health', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
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
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
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
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
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
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
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

  app.get('/admin/reports/:chatId', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const params = reportsParamsSchema.parse(request.params);
    const query = adminListQuerySchema.parse(request.query);
    return {
      ok: true,
      reports: await telegram.getReportsByChat(params.chatId, query.limit)
    };
  });

  app.get('/admin/feedback/:chatId', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const params = reportsParamsSchema.parse(request.params);
    const query = adminListQuerySchema.parse(request.query);
    return {
      ok: true,
      feedback: await telegram.getFeedbackByChat(params.chatId, query.limit)
    };
  });

  app.get('/admin/analytics/telegram-flows', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    return {
      ok: true,
      counters: await telegram.getFlowCounters(),
      timestamp: new Date().toISOString()
    };
  });

  app.get('/admin/analytics/telegram-flows/summary', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const counters = normalizeFlowCounters(await telegram.getFlowCounters());
    const values = buildFlowCounterValueMap(counters);

    return {
      ok: true,
      summary: {
        feedback: buildFlowSummary(values.feedback_started, values.feedback_saved, values.feedback_cancelled),
        modeRecommendation: buildFlowSummary(
          values.mode_recommendation_started,
          values.mode_recommendation_suggested,
          values.mode_recommendation_cancelled
        )
      },
      counters,
      timestamp: new Date().toISOString()
    };
  });

  app.get('/admin/analytics/telegram-flows/daily', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminAuthorized(request.headers['x-admin-key'], adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    const query = adminAnalyticsDaysQuerySchema.parse(request.query);
    const rows = normalizeFlowDailyCounters(await telegram.getFlowDailyCounters(query.days));

    return {
      ok: true,
      days: query.days,
      timezone: 'UTC',
      rows,
      daily: buildFlowDailyTimeline(rows, query.days),
      timestamp: new Date().toISOString()
    };
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

const isWebhookAuthorized = (headerValue: string | string[] | undefined, webhookSecret?: string): boolean => {
  if (!webhookSecret) {
    return true;
  }
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return token === webhookSecret;
};

const getClientKey = (forwardedForHeader: string | string[] | undefined, fallbackIp: string): string => {
  const value = Array.isArray(forwardedForHeader) ? forwardedForHeader[0] : forwardedForHeader;
  const ip = value?.split(',')[0]?.trim();
  return ip || fallbackIp || 'unknown';
};

const isAdminWithinRateLimit = async (
  rateLimit: BuildAppOptions['rateLimit'],
  forwardedForHeader: string | string[] | undefined,
  fallbackIp: string
): Promise<boolean> => {
  const result = await rateLimit.checkAdmin(getClientKey(forwardedForHeader, fallbackIp));
  return result.allowed;
};

const normalizeFlowCounters = (rows: unknown[]): FlowCounterRow[] =>
  rows.filter(isFlowCounterRow).map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt
  }));

const normalizeFlowDailyCounters = (rows: unknown[]): FlowDailyCounterRow[] =>
  rows.filter(isFlowDailyCounterRow).map((row) => ({
    date: row.date,
    key: row.key,
    value: row.value
  }));

const isFlowCounterRow = (value: unknown): value is FlowCounterRow => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.key === 'string' &&
    FLOW_COUNTER_KEYS.includes(row.key as FlowCounterKey) &&
    typeof row.value === 'number' &&
    Number.isFinite(row.value)
  );
};

const isFlowDailyCounterRow = (value: unknown): value is FlowDailyCounterRow => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    typeof row.key === 'string' &&
    FLOW_COUNTER_KEYS.includes(row.key as FlowCounterKey) &&
    typeof row.value === 'number' &&
    Number.isFinite(row.value)
  );
};

const buildFlowCounterValueMap = (counters: FlowCounterRow[]): Record<FlowCounterKey, number> => {
  const values = Object.fromEntries(FLOW_COUNTER_KEYS.map((key) => [key, 0])) as Record<FlowCounterKey, number>;
  for (const counter of counters) {
    values[counter.key] = counter.value;
  }
  return values;
};

const buildFlowSummary = (started: number, completed: number, cancelled: number) => {
  const dropped = Math.max(started - completed - cancelled, 0);
  return {
    started,
    completed,
    cancelled,
    dropped,
    completionRatePct: toRatePct(completed, started),
    cancelRatePct: toRatePct(cancelled, started),
    dropRatePct: toRatePct(dropped, started)
  };
};

const buildFlowDailyTimeline = (rows: FlowDailyCounterRow[], days: number) => {
  const entries = new Map<string, Record<FlowCounterKey, number>>();

  for (const date of listRecentUtcDates(days)) {
    entries.set(date, buildFlowCounterValueMap([]));
  }

  for (const row of rows) {
    const current = entries.get(row.date) ?? buildFlowCounterValueMap([]);
    current[row.key] = row.value;
    entries.set(row.date, current);
  }

  return Array.from(entries.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counters]) => ({
      date,
      counters,
      summary: {
        feedback: buildFlowSummary(counters.feedback_started, counters.feedback_saved, counters.feedback_cancelled),
        modeRecommendation: buildFlowSummary(
          counters.mode_recommendation_started,
          counters.mode_recommendation_suggested,
          counters.mode_recommendation_cancelled
        )
      }
    }));
};

const toRatePct = (part: number, total: number): number | null => {
  if (total <= 0) {
    return null;
  }
  return Math.round((part / total) * 1000) / 10;
};

const listRecentUtcDates = (days: number): string[] => {
  const today = new Date();
  const result: string[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    result.push(date.toISOString().slice(0, 10));
  }

  return result;
};
