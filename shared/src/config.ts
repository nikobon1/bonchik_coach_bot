import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL_ANALYZER: z.string().min(1),
  OPENROUTER_MODEL_REPORTER: z.string().min(1),
  OPENROUTER_MODEL_REPORTER_FAST: z.string().min(1).optional(),
  OPENROUTER_MODEL_EMBEDDING: z.string().min(1),
  OPENROUTER_MODEL_TRANSCRIBER: z.string().min(1).default('openai/whisper-1'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_URL: z.string().url(),
  ADMIN_API_KEY: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  MORNING_SUMMARY_ENABLED: booleanFromEnv.default(true),
  MORNING_SUMMARY_CRON: z.string().min(1).default('0 8 * * *'),
  MORNING_SUMMARY_TZ: z.string().min(1).default('Europe/Moscow'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ROLE: z.enum(['api', 'worker']).default('api')
});

export type AppConfig = z.infer<typeof envSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => envSchema.parse(env);
