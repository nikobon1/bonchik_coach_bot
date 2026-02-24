import assert from 'node:assert/strict';
import { buildApp } from './app';
import { createLogger } from '@bonchik/shared';

const run = async (): Promise<void> => {
  let queued = 0;
  let requeued = 0;
  const seenUpdates = new Set<number>();
  const todayUtc = new Date().toISOString().slice(0, 10);
  const healthyApp = buildApp({
    logger: createLogger('api-test'),
    adminApiKey: 'test-admin-key',
    rateLimit: {
      checkWebhook: async () => ({ allowed: true, retryAfterSec: 0 }),
      checkAdmin: async () => ({ allowed: true, retryAfterSec: 0 })
    },
    checks: {
      checkDb: async () => undefined,
      checkRedis: async () => undefined
    },
    telegram: {
      webhookSecret: 'test-webhook-secret',
      enqueueMessage: async () => {
        queued += 1;
      },
      markUpdateProcessed: async (updateId) => {
        if (seenUpdates.has(updateId)) {
          return false;
        }
        seenUpdates.add(updateId);
        return true;
      },
      getQueueHealth: async () => ({
        main: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
        dlq: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
      }),
      getFailedJobs: async () => [],
      getDlqJobs: async () => [],
      requeueDlqJob: async () => {
        requeued += 1;
        return true;
      },
      getReportsByChat: async () => [{ id: 1, chatId: 1 }],
      getFeedbackByChat: async () => [{ id: 1, chatId: 1, message: 'good bot' }],
      getFlowCounters: async () => [{ key: 'feedback_started', value: 2, updatedAt: new Date().toISOString() }],
      getFlowDailyCounters: async () => [
        { date: todayUtc, key: 'feedback_started', value: 2 },
        { date: todayUtc, key: 'feedback_saved', value: 1 }
      ],
      getMorningSummaryStatus: async () => ({
        enabled: true,
        cron: '0 8 * * *',
        timezone: 'Europe/Moscow',
        stats: {
          totalSent: 3,
          sentLast24h: 1,
          sentTodayUtc: 1,
          distinctChatsLast7d: 2,
          lastSentAt: new Date().toISOString(),
          lastSummaryDate: todayUtc,
          lastTimezone: 'Europe/Moscow',
          lastChatId: 1,
          lastUserId: 2,
          lastReportsCount: 4
        }
      })
    }
  });

  const healthyResponse = await healthyApp.inject({ method: 'GET', url: '/health' });
  assert.equal(healthyResponse.statusCode, 200);
  assert.equal(healthyResponse.json().status, 'ok');

  const adminUiResponse = await healthyApp.inject({ method: 'GET', url: '/admin/ui' });
  assert.equal(adminUiResponse.statusCode, 200);
  assert.equal(adminUiResponse.headers['content-type']?.includes('text/html'), true);
  assert.equal(adminUiResponse.body.includes('Admin Panel: Telegram Analytics'), true);

  const uiSessionBeforeLogin = await healthyApp.inject({ method: 'GET', url: '/admin/ui/session' });
  assert.equal(uiSessionBeforeLogin.statusCode, 200);
  assert.equal(uiSessionBeforeLogin.json().authenticated, false);

  const uiLoginResponse = await healthyApp.inject({
    method: 'POST',
    url: '/admin/ui/login',
    payload: { adminApiKey: 'test-admin-key' }
  });
  assert.equal(uiLoginResponse.statusCode, 200);
  assert.equal(uiLoginResponse.json().ok, true);
  const uiCookieHeader = uiLoginResponse.headers['set-cookie'];
  assert.equal(typeof uiCookieHeader, 'string');

  const uiSessionAfterLogin = await healthyApp.inject({
    method: 'GET',
    url: '/admin/ui/session',
    headers: { cookie: uiCookieHeader as string }
  });
  assert.equal(uiSessionAfterLogin.statusCode, 200);
  assert.equal(uiSessionAfterLogin.json().authenticated, true);

  const uiSummaryResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/ui/api/analytics/telegram-flows/summary',
    headers: { cookie: uiCookieHeader as string }
  });
  assert.equal(uiSummaryResponse.statusCode, 200);
  assert.equal(uiSummaryResponse.json().ok, true);

  const uiMorningSummaryResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/ui/api/morning-summary/status',
    headers: { cookie: uiCookieHeader as string }
  });
  assert.equal(uiMorningSummaryResponse.statusCode, 200);
  assert.equal(uiMorningSummaryResponse.json().ok, true);
  assert.equal(uiMorningSummaryResponse.json().stats.totalSent, 3);

  const webhookResponse = await healthyApp.inject({
    method: 'POST',
    url: '/telegram/webhook',
    payload: {
      update_id: 123,
      message: {
        text: 'hi',
        chat: { id: 1 },
        from: { id: 2, username: 'tester' }
      }
    },
    headers: {
      'x-telegram-bot-api-secret-token': 'test-webhook-secret'
    }
  });
  assert.equal(webhookResponse.statusCode, 200);
  assert.equal(queued, 1);

  const duplicateWebhookResponse = await healthyApp.inject({
    method: 'POST',
    url: '/telegram/webhook',
    payload: {
      update_id: 123,
      message: {
        text: 'hi again',
        chat: { id: 1 },
        from: { id: 2, username: 'tester' }
      }
    },
    headers: {
      'x-telegram-bot-api-secret-token': 'test-webhook-secret'
    }
  });
  assert.equal(duplicateWebhookResponse.statusCode, 200);
  assert.equal(duplicateWebhookResponse.json().duplicate, true);
  assert.equal(queued, 1);

  const voiceWebhookResponse = await healthyApp.inject({
    method: 'POST',
    url: '/telegram/webhook',
    payload: {
      update_id: 124,
      message: {
        voice: {
          file_id: 'voice-file-id',
          mime_type: 'audio/ogg'
        },
        chat: { id: 1 },
        from: { id: 2, username: 'tester' }
      }
    },
    headers: {
      'x-telegram-bot-api-secret-token': 'test-webhook-secret'
    }
  });
  assert.equal(voiceWebhookResponse.statusCode, 200);
  assert.equal(queued, 2);

  const adminUnauthorized = await healthyApp.inject({
    method: 'GET',
    url: '/admin/queue/health'
  });
  assert.equal(adminUnauthorized.statusCode, 401);

  const adminAuthorized = await healthyApp.inject({
    method: 'GET',
    url: '/admin/queue/health',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(adminAuthorized.statusCode, 200);
  assert.equal(adminAuthorized.json().ok, true);

  const requeueResponse = await healthyApp.inject({
    method: 'POST',
    url: '/admin/queue/dlq/requeue/job-1',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(requeueResponse.statusCode, 200);
  assert.equal(requeued, 1);

  const reportsResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/reports/1?limit=10',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(reportsResponse.statusCode, 200);
  assert.equal(reportsResponse.json().ok, true);
  assert.equal(Array.isArray(reportsResponse.json().reports), true);

  const feedbackResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/feedback/1?limit=10',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(feedbackResponse.statusCode, 200);
  assert.equal(feedbackResponse.json().ok, true);
  assert.equal(Array.isArray(feedbackResponse.json().feedback), true);

  const flowCountersResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/analytics/telegram-flows',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(flowCountersResponse.statusCode, 200);
  assert.equal(flowCountersResponse.json().ok, true);
  assert.equal(Array.isArray(flowCountersResponse.json().counters), true);

  const flowSummaryResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/analytics/telegram-flows/summary',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(flowSummaryResponse.statusCode, 200);
  assert.equal(flowSummaryResponse.json().ok, true);
  assert.equal(flowSummaryResponse.json().summary.feedback.started, 2);
  assert.equal(flowSummaryResponse.json().summary.feedback.completionRatePct, 0);

  const flowDailyResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/analytics/telegram-flows/daily?days=7',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(flowDailyResponse.statusCode, 200);
  assert.equal(flowDailyResponse.json().ok, true);
  assert.equal(flowDailyResponse.json().days, 7);
  assert.equal(Array.isArray(flowDailyResponse.json().rows), true);
  assert.equal(Array.isArray(flowDailyResponse.json().daily), true);
  assert.equal(flowDailyResponse.json().daily.at(-1).summary.feedback.started, 2);
  assert.equal(flowDailyResponse.json().daily.at(-1).summary.feedback.completed, 1);

  const morningSummaryStatusResponse = await healthyApp.inject({
    method: 'GET',
    url: '/admin/morning-summary/status',
    headers: {
      'x-admin-key': 'test-admin-key'
    }
  });
  assert.equal(morningSummaryStatusResponse.statusCode, 200);
  assert.equal(morningSummaryStatusResponse.json().ok, true);
  assert.equal(morningSummaryStatusResponse.json().enabled, true);

  await healthyApp.close();

  const rateLimitedApp = buildApp({
    logger: createLogger('api-test'),
    adminApiKey: 'test-admin-key',
    rateLimit: {
      checkWebhook: async () => ({ allowed: false, retryAfterSec: 60 }),
      checkAdmin: async () => ({ allowed: false, retryAfterSec: 60 })
    },
    checks: {
      checkDb: async () => undefined,
      checkRedis: async () => undefined
    },
    telegram: {
      webhookSecret: 'test-webhook-secret',
      enqueueMessage: async () => undefined,
      markUpdateProcessed: async () => true,
      getQueueHealth: async () => ({
        main: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        dlq: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
      }),
      getFailedJobs: async () => [],
      getDlqJobs: async () => [],
      requeueDlqJob: async () => false,
      getReportsByChat: async () => [],
      getFeedbackByChat: async () => [],
      getFlowCounters: async () => [],
      getFlowDailyCounters: async () => [],
      getMorningSummaryStatus: async () => ({
        enabled: false,
        cron: '0 8 * * *',
        timezone: 'Europe/Moscow',
        stats: { totalSent: 0, sentLast24h: 0, sentTodayUtc: 0, distinctChatsLast7d: 0 }
      })
    }
  });

  const limitedWebhook = await rateLimitedApp.inject({
    method: 'POST',
    url: '/telegram/webhook',
    payload: { update_id: 999 }
  });
  assert.equal(limitedWebhook.statusCode, 429);

  const limitedAdmin = await rateLimitedApp.inject({
    method: 'GET',
    url: '/admin/queue/health',
    headers: { 'x-admin-key': 'test-admin-key' }
  });
  assert.equal(limitedAdmin.statusCode, 429);

  await rateLimitedApp.close();

  const degradedApp = buildApp({
    logger: createLogger('api-test'),
    rateLimit: {
      checkWebhook: async () => ({ allowed: true, retryAfterSec: 0 }),
      checkAdmin: async () => ({ allowed: true, retryAfterSec: 0 })
    },
    checks: {
      checkDb: async () => {
        throw new Error('db down');
      },
      checkRedis: async () => undefined
    },
    telegram: {
      webhookSecret: 'test-webhook-secret',
      enqueueMessage: async () => undefined,
      markUpdateProcessed: async () => true,
      getQueueHealth: async () => ({
        main: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        dlq: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
      }),
      getFailedJobs: async () => [],
      getDlqJobs: async () => [],
      requeueDlqJob: async () => false,
      getReportsByChat: async () => [],
      getFeedbackByChat: async () => [],
      getFlowCounters: async () => [],
      getFlowDailyCounters: async () => [],
      getMorningSummaryStatus: async () => ({
        enabled: false,
        cron: '0 8 * * *',
        timezone: 'Europe/Moscow',
        stats: { totalSent: 0, sentLast24h: 0, sentTodayUtc: 0, distinctChatsLast7d: 0 }
      })
    }
  });

  const degradedResponse = await degradedApp.inject({ method: 'GET', url: '/health' });
  assert.equal(degradedResponse.statusCode, 503);
  assert.equal(degradedResponse.json().status, 'degraded');
  await degradedApp.close();
};

run().catch((error) => {
  // Fail CI with useful stack trace if any assertion crashes.
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
