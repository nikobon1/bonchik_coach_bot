import type Redis from 'ioredis';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

const sanitizeTtl = (ttl: number, fallback: number): number => (ttl > 0 ? ttl : fallback);

export const consumeRateLimit = async (
  redis: Redis,
  key: string,
  maxRequests: number,
  windowSec: number
): Promise<RateLimitResult> => {
  const result = (await redis.eval(RATE_LIMIT_LUA, 1, key, windowSec)) as [number, number];
  const count = Number(result[0] ?? 0);
  const ttl = sanitizeTtl(Number(result[1] ?? windowSec), windowSec);

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSec: ttl
  };
};