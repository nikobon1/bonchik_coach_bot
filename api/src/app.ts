import { createHmac, timingSafeEqual } from 'node:crypto';
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

const adminUiLoginSchema = z.object({
  adminApiKey: z.string().min(1)
});

const ADMIN_UI_SESSION_COOKIE = 'admin_ui_session';
const ADMIN_UI_SESSION_TTL_SEC = 60 * 60 * 24 * 30;

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

  app.get('/admin/ui', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderAdminUiHtml();
  });

  app.get('/admin/ui/session', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }

    return {
      ok: true,
      authenticated: isAdminUiSessionAuthorized(request.headers.cookie, adminApiKey)
    };
  });

  app.post('/admin/ui/login', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }

    const body = adminUiLoginSchema.parse(request.body);
    if (!isAdminTokenAuthorized(body.adminApiKey, adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    reply.header('Set-Cookie', createAdminUiSessionCookie(adminApiKey));
    return { ok: true };
  });

  app.post('/admin/ui/logout', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }

    reply.header('Set-Cookie', clearAdminUiSessionCookie());
    return { ok: true };
  });

  app.get('/admin/ui/api/analytics/telegram-flows', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminUiSessionAuthorized(request.headers.cookie, adminApiKey)) {
      reply.code(401);
      return { ok: false };
    }

    return {
      ok: true,
      counters: await telegram.getFlowCounters(),
      timestamp: new Date().toISOString()
    };
  });

  app.get('/admin/ui/api/analytics/telegram-flows/summary', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminUiSessionAuthorized(request.headers.cookie, adminApiKey)) {
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

  app.get('/admin/ui/api/analytics/telegram-flows/daily', async (request, reply) => {
    if (!(await isAdminWithinRateLimit(rateLimit, request.headers['x-forwarded-for'], request.ip))) {
      reply.code(429);
      return { ok: false, error: 'rate_limited' };
    }
    if (!isAdminUiSessionAuthorized(request.headers.cookie, adminApiKey)) {
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

const isAdminTokenAuthorized = (token: string | undefined, adminApiKey?: string): boolean => {
  if (!adminApiKey || !token) {
    return false;
  }
  return token === adminApiKey;
};

const isAdminAuthorized = (headerValue: string | string[] | undefined, adminApiKey?: string): boolean => {
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isAdminTokenAuthorized(token, adminApiKey);
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

const createAdminUiSessionCookie = (adminApiKey?: string): string => {
  if (!adminApiKey) {
    return clearAdminUiSessionCookie();
  }

  const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_UI_SESSION_TTL_SEC;
  const signature = signAdminUiSession(adminApiKey, expiresAtSec);
  const value = `${expiresAtSec}.${signature}`;

  return [
    `${ADMIN_UI_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/admin/ui',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${ADMIN_UI_SESSION_TTL_SEC}`
  ].join('; ');
};

const clearAdminUiSessionCookie = (): string =>
  [
    `${ADMIN_UI_SESSION_COOKIE}=`,
    'Path=/admin/ui',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0'
  ].join('; ');

const isAdminUiSessionAuthorized = (cookieHeader: string | string[] | undefined, adminApiKey?: string): boolean => {
  if (!adminApiKey) {
    return false;
  }

  const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!rawCookie) {
    return false;
  }

  const cookieValue = getCookieValue(rawCookie, ADMIN_UI_SESSION_COOKIE);
  if (!cookieValue) {
    return false;
  }

  const decoded = decodeURIComponent(cookieValue);
  const [expiresAtSecText, signature] = decoded.split('.', 2);
  const expiresAtSec = Number(expiresAtSecText);
  if (!Number.isInteger(expiresAtSec) || !signature) {
    return false;
  }

  if (expiresAtSec < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = signAdminUiSession(adminApiKey, expiresAtSec);
  return safeEqualHex(signature, expected);
};

const signAdminUiSession = (adminApiKey: string, expiresAtSec: number): string =>
  createHmac('sha256', adminApiKey).update(`exp=${expiresAtSec}`).digest('hex');

const getCookieValue = (cookieHeader: string, name: string): string | undefined => {
  const prefix = `${name}=`;
  const part = cookieHeader
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(prefix));

  if (!part) {
    return undefined;
  }

  return part.slice(prefix.length);
};

const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return timingSafeEqual(aBuf, bBuf);
};

const renderAdminUiHtml = (): string => `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bot Coach Anna Admin</title>
    <style>
      :root {
        --bg: #f7f4ee;
        --card: #fffdf8;
        --ink: #1f1f1b;
        --muted: #6f6a5f;
        --line: #ddd4c7;
        --accent: #0f766e;
        --accent-2: #0b5f58;
        --warn: #8a4b08;
        --good: #166534;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 0% 0%, #efe8da 0%, transparent 55%),
          radial-gradient(circle at 100% 0%, #e0efe8 0%, transparent 50%),
          var(--bg);
      }
      .wrap {
        max-width: 1080px;
        margin: 0 auto;
        padding: 20px;
      }
      .hero {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #fffdf9 0%, #f8f2e9 100%);
        border-radius: 14px;
        padding: 18px;
        margin-bottom: 14px;
      }
      h1 {
        margin: 0 0 6px 0;
        font-size: 24px;
      }
      .muted { color: var(--muted); margin: 0; }
      .controls {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
        border: 1px solid var(--line);
        background: var(--card);
        border-radius: 14px;
        padding: 14px;
        margin-bottom: 14px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 120px auto auto auto;
        gap: 10px;
        align-items: end;
      }
      label {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 4px;
      }
      input, select, button {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--line);
        padding: 10px 12px;
        font: inherit;
        background: #fff;
        color: var(--ink);
      }
      button {
        width: auto;
        cursor: pointer;
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      button.secondary {
        background: #fff;
        color: var(--ink);
      }
      button:hover { background: var(--accent-2); }
      button.secondary:hover { background: #f7f3eb; }
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 14px;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--card);
        border-radius: 14px;
        padding: 14px;
      }
      .card h2 {
        margin: 0 0 8px 0;
        font-size: 16px;
      }
      .kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 10px;
        font-size: 14px;
      }
      .kv b { color: var(--muted); font-weight: 600; }
      .status {
        margin-top: 8px;
        font-size: 13px;
      }
      .status.good { color: var(--good); }
      .status.warn { color: var(--warn); }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        background: #fff;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 8px 6px;
        text-align: right;
        white-space: nowrap;
      }
      th:first-child, td:first-child { text-align: left; }
      .panel {
        border: 1px solid var(--line);
        background: var(--card);
        border-radius: 14px;
        padding: 14px;
      }
      pre {
        background: #fbfaf6;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        overflow: auto;
        font-size: 12px;
      }
      @media (max-width: 880px) {
        .row {
          grid-template-columns: 1fr;
          align-items: stretch;
        }
        .cards {
          grid-template-columns: 1fr;
        }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <h1>Admin Panel: Telegram Analytics</h1>
        <p class="muted">Сводка и история по flow "feedback" и "подбор режима" (через существующие admin API).</p>
      </section>

      <section class="controls">
        <div class="row">
          <div>
            <label for="adminKey">Admin API Key</label>
            <input id="adminKey" type="password" placeholder="Вставьте ADMIN_API_KEY" autocomplete="off" />
          </div>
          <div>
            <label for="days">Days</label>
            <input id="days" type="number" min="1" max="90" value="14" />
          </div>
          <button id="refreshBtn" type="button">Обновить</button>
          <button id="saveBtn" type="button" class="secondary">Сохранить ключ</button>
          <button id="clearBtn" type="button" class="secondary">Очистить ключ</button>
        </div>
        <div id="status" class="status">Готово.</div>
      </section>

      <section class="cards">
        <article class="card">
          <h2>Feedback</h2>
          <div id="feedbackSummary" class="kv"></div>
        </article>
        <article class="card">
          <h2>Mode Recommendation</h2>
          <div id="modeSummary" class="kv"></div>
        </article>
      </section>

      <section class="panel" style="margin-bottom:14px;">
        <h2 style="margin-top:0;">Daily Timeline (UTC)</h2>
        <div style="overflow:auto;">
          <table id="dailyTable">
            <thead>
              <tr>
                <th>Date</th>
                <th>F Start</th>
                <th>F Done</th>
                <th>F Cancel</th>
                <th>F Drop</th>
                <th>M Start</th>
                <th>M Done</th>
                <th>M Cancel</th>
                <th>M Drop</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <h2 style="margin-top:0;">Raw API (debug)</h2>
        <pre id="rawJson">Нажмите "Обновить"</pre>
      </section>
    </div>

    <script>
      const els = {
        adminKey: document.getElementById('adminKey'),
        days: document.getElementById('days'),
        refreshBtn: document.getElementById('refreshBtn'),
        saveBtn: document.getElementById('saveBtn'),
        clearBtn: document.getElementById('clearBtn'),
        status: document.getElementById('status'),
        feedbackSummary: document.getElementById('feedbackSummary'),
        modeSummary: document.getElementById('modeSummary'),
        dailyBody: document.querySelector('#dailyTable tbody'),
        rawJson: document.getElementById('rawJson')
      };
      const state = { authenticated: false };

      const setStatus = (text, kind) => {
        els.status.textContent = text;
        els.status.className = 'status' + (kind ? ' ' + kind : '');
      };

      const setAuthUi = (authenticated) => {
        state.authenticated = authenticated;
        els.adminKey.disabled = authenticated;
        els.refreshBtn.disabled = !authenticated;
        els.saveBtn.textContent = authenticated ? 'Login OK' : 'Login';
        els.clearBtn.textContent = authenticated ? 'Logout' : 'Clear';
      };

      const fetchJson = async (path, options = {}) => {
        const response = await fetch(path, {
          credentials: 'same-origin',
          ...options,
          headers: {
            'content-type': 'application/json',
            ...(options.headers || {})
          }
        });
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('API returned non-JSON');
        }
        if (!response.ok || data.ok === false) {
          const message = data.error ? 'API error: ' + data.error : 'HTTP ' + response.status;
          const error = new Error(message);
          error.statusCode = response.status;
          throw error;
        }
        return data;
      };
      const renderKv = (container, rows) => {
        container.innerHTML = '';
        for (const [k, v] of rows) {
          const keyEl = document.createElement('b');
          keyEl.textContent = k;
          const valEl = document.createElement('span');
          valEl.textContent = String(v ?? '');
          container.appendChild(keyEl);
          container.appendChild(valEl);
        }
      };

      const renderDailyTable = (daily) => {
        els.dailyBody.innerHTML = '';
        for (const row of daily || []) {
          const tr = document.createElement('tr');
          const f = row.summary?.feedback || {};
          const m = row.summary?.modeRecommendation || {};
          const cells = [
            row.date,
            f.started ?? 0,
            f.completed ?? 0,
            f.cancelled ?? 0,
            f.dropped ?? 0,
            m.started ?? 0,
            m.completed ?? 0,
            m.cancelled ?? 0,
            m.dropped ?? 0
          ];
          cells.forEach((value, index) => {
            const td = document.createElement('td');
            td.textContent = String(value);
            if (index === 0) td.style.textAlign = 'left';
            tr.appendChild(td);
          });
          els.dailyBody.appendChild(tr);
        }
      };
      const clearRenderedData = () => {
        els.feedbackSummary.innerHTML = '';
        els.modeSummary.innerHTML = '';
        els.dailyBody.innerHTML = '';
        els.rawJson.textContent = 'Press Refresh after login';
      };

      const refresh = async () => {
        if (!state.authenticated) {
          setStatus('Login first.', 'warn');
          return;
        }

        const days = Math.min(90, Math.max(1, Number(els.days.value || '14')));
        els.days.value = String(days);
        setStatus('Loading...', 'warn');
        try {
          const [summary, daily, raw] = await Promise.all([
            fetchJson('/admin/ui/api/analytics/telegram-flows/summary', { headers: {} }),
            fetchJson('/admin/ui/api/analytics/telegram-flows/daily?days=' + encodeURIComponent(String(days)), { headers: {} }),
            fetchJson('/admin/ui/api/analytics/telegram-flows', { headers: {} })
          ]);

          renderKv(els.feedbackSummary, [
            ['started', summary.summary.feedback.started],
            ['completed', summary.summary.feedback.completed],
            ['cancelled', summary.summary.feedback.cancelled],
            ['dropped', summary.summary.feedback.dropped],
            ['completionRatePct', summary.summary.feedback.completionRatePct],
            ['cancelRatePct', summary.summary.feedback.cancelRatePct],
            ['dropRatePct', summary.summary.feedback.dropRatePct]
          ]);

          renderKv(els.modeSummary, [
            ['started', summary.summary.modeRecommendation.started],
            ['completed', summary.summary.modeRecommendation.completed],
            ['cancelled', summary.summary.modeRecommendation.cancelled],
            ['dropped', summary.summary.modeRecommendation.dropped],
            ['completionRatePct', summary.summary.modeRecommendation.completionRatePct],
            ['cancelRatePct', summary.summary.modeRecommendation.cancelRatePct],
            ['dropRatePct', summary.summary.modeRecommendation.dropRatePct]
          ]);

          renderDailyTable(daily.daily);
          els.rawJson.textContent = JSON.stringify({ summary, daily, raw }, null, 2);
          setStatus('Data refreshed.', 'good');
        } catch (error) {
          if (error && typeof error === 'object' && error.statusCode === 401) {
            setAuthUi(false);
            clearRenderedData();
            setStatus('Session expired. Login again.', 'warn');
            return;
          }
          setStatus(error instanceof Error ? error.message : 'Load failed', 'warn');
        }
      };

      const login = async () => {
        const key = els.adminKey.value.trim();
        if (!key) {
          setStatus('Enter ADMIN_API_KEY.', 'warn');
          return;
        }

        setStatus('Signing in...', 'warn');
        try {
          await fetchJson('/admin/ui/login', {
            method: 'POST',
            body: JSON.stringify({ adminApiKey: key }),
            headers: {}
          });
          els.adminKey.value = '';
          setAuthUi(true);
          setStatus('Login OK. Loading data...', 'good');
          await refresh();
        } catch (error) {
          setAuthUi(false);
          setStatus(error instanceof Error ? error.message : 'Login failed', 'warn');
        }
      };

      const logout = async () => {
        try {
          await fetchJson('/admin/ui/logout', { method: 'POST', body: '{}', headers: {} });
        } catch {
          // Ignore logout errors and clear UI state locally.
        }
        setAuthUi(false);
        els.adminKey.value = '';
        clearRenderedData();
        setStatus('Logged out.', 'good');
      };
      els.saveBtn.addEventListener('click', () => {
        if (state.authenticated) {
          setStatus('Already logged in.', 'good');
          return;
        }
        void login();
      });

      els.clearBtn.addEventListener('click', () => {
        if (state.authenticated) {
          void logout();
          return;
        }
        els.adminKey.value = '';
        setStatus('Input cleared.', 'good');
      });

      els.refreshBtn.addEventListener('click', () => {
        void refresh();
      });

      els.adminKey.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !state.authenticated) {
          event.preventDefault();
          void login();
        }
      });

      const boot = async () => {
        clearRenderedData();
        setAuthUi(false);
        setStatus('Checking session...', 'warn');
        try {
          const session = await fetchJson('/admin/ui/session', { headers: {} });
          if (session.authenticated) {
            setAuthUi(true);
            setStatus('Session restored. Loading data...', 'good');
            await refresh();
          } else {
            setAuthUi(false);
            setStatus('Enter ADMIN_API_KEY and click Login.', 'warn');
          }
        } catch (error) {
          setAuthUi(false);
          setStatus(error instanceof Error ? error.message : 'Session check failed', 'warn');
        }
      };

      void boot();
    </script>
  </body>
</html>`;

