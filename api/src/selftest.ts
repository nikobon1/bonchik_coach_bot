import assert from 'node:assert/strict';
import { buildApp } from './app';
import { createLogger } from '@bonchik/shared';

const run = async (): Promise<void> => {
  const healthyApp = buildApp({
    logger: createLogger('api-test'),
    checks: {
      checkDb: async () => undefined,
      checkRedis: async () => undefined
    }
  });

  const healthyResponse = await healthyApp.inject({ method: 'GET', url: '/health' });
  assert.equal(healthyResponse.statusCode, 200);
  assert.equal(healthyResponse.json().status, 'ok');
  await healthyApp.close();

  const degradedApp = buildApp({
    logger: createLogger('api-test'),
    checks: {
      checkDb: async () => {
        throw new Error('db down');
      },
      checkRedis: async () => undefined
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
