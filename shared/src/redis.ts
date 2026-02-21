import Redis from 'ioredis';

export const createRedisConnection = (redisUrl: string) =>
  new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

export const pingRedis = async (redis: Redis): Promise<void> => {
  await redis.ping();
};