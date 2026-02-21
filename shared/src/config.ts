import { z } from 'zod';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL_ANALYZER: z.string().min(1),
  OPENROUTER_MODEL_REPORTER: z.string().min(1),
  OPENROUTER_MODEL_EMBEDDING: z.string().min(1),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_URL: z.string().url(),
  ADMIN_API_KEY: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ROLE: z.enum(['api', 'worker']).default('api')
});

export type AppConfig = z.infer<typeof envSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => envSchema.parse(env);
