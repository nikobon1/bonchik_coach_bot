import pino from 'pino';

export const createLogger = (service: string) =>
  pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime
  });