import Redis from 'ioredis';

export const createRedisConnection = (redisUrl: string) =>
  new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

export const pingRedis = async (redis: Redis): Promise<void> => {
  await redis.ping();
};

export const assertRedisAvailable = async (redisUrl: string): Promise<void> => {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: () => null
  });
  let lastConnectionError: unknown;

  // Suppress probe-level ioredis error events; startup should fail via the thrown exception below.
  redis.on('error', (error) => {
    lastConnectionError = error;
  });

  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    const rootCause = lastConnectionError ?? error;
    throw new Error(`Redis startup check failed for ${sanitizeRedisUrl(redisUrl)}: ${formatRedisError(rootCause)}`);
  } finally {
    redis.disconnect();
  }
};

const sanitizeRedisUrl = (redisUrl: string): string => {
  try {
    const parsed = new URL(redisUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return redisUrl;
  }
};

const formatRedisError = (error: unknown): string => {
  if (error instanceof AggregateError) {
    const nested = Array.from(error.errors ?? [])
      .map((entry) => formatRedisError(entry))
      .filter(Boolean);

    if (nested.length > 0) {
      return nested.join('; ');
    }
  }

  if (error instanceof Error) {
    const details: string[] = [];
    const knownError = error as Error & {
      code?: string;
      address?: string;
      port?: number;
      cause?: unknown;
    };

    if (knownError.code) {
      details.push(knownError.code);
    }
    if (knownError.address) {
      details.push(knownError.port ? `${knownError.address}:${knownError.port}` : knownError.address);
    }
    if (error.message) {
      details.push(error.message);
    }
    if (details.length > 0) {
      return details.join(' ');
    }
    if (knownError.cause) {
      return formatRedisError(knownError.cause);
    }
  }

  return 'unknown Redis connection error';
};
