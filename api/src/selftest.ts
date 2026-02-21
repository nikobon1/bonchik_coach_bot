import assert from 'node:assert/strict';
import { buildApp } from './app';
import { createLogger } from '@bonchik/shared';

const run = async (): Promise<void> => {
  let queued = 0;
  let requeued = 0;
  let firstUpdate = true;
  const healthyApp = buildApp({
    logger: createLogger('api-test'),
    adminApiKey: 'test-admin-key',
    checks: {
      checkDb: async () => undefined,
      checkRedis: async () => undefined
    },
    telegram: {
      webhookSecret: 'test-webhook-secret',
      enqueueMessage: async () => {
        queued += 1;
      },
      markUpdateProcessed: async () => {
        if (firstUpdate) {
          firstUpdate = false;
          return true;
        }
        return false;
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
      }
    }
  });

  const healthyResponse = await healthyApp.inject({ method: 'GET', url: '/health' });
  assert.equal(healthyResponse.statusCode, 200);
  assert.equal(healthyResponse.json().status, 'ok');

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

  await healthyApp.close();

  const degradedApp = buildApp({
    logger: createLogger('api-test'),
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
      requeueDlqJob: async () => false
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
