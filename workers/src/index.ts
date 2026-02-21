import {
  appendChatMessage,
  createDbPool,
  createLogger,
  createOpenRouterChatCompletion,
  createTelegramWorker,
  getRecentChatHistory,
  loadConfig,
  runMigrations,
  sendTelegramMessage,
  type TelegramJobPayload
} from '@bonchik/shared';

type DbPool = ReturnType<typeof createDbPool>;
type AppLogger = ReturnType<typeof createLogger>;
type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
};

const OPENROUTER_TIMEOUT_MS = 20_000;
const TELEGRAM_MESSAGE_MAX_LENGTH = 4000;
const FALLBACK_REPLY =
  'Sorry, I could not process that request right now. Please try again in a few seconds.';

const startWorker = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('worker');
  const pool = createDbPool(config.DATABASE_URL);
  await runMigrations(pool);

  const worker = createTelegramWorker(config.REDIS_URL, logger, async (payload) =>
    processTelegramJob(
      payload,
      pool,
      config.OPENROUTER_API_KEY,
      config.OPENROUTER_MODEL_REPORTER,
      config.TELEGRAM_BOT_TOKEN,
      logger
    )
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.info('Worker started and waiting for jobs');
};

const processTelegramJob = async (
  payload: TelegramJobPayload,
  pool: DbPool,
  openRouterApiKey: string,
  openRouterModel: string,
  telegramBotToken: string,
  logger: AppLogger
): Promise<void> => {
  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'user',
    content: payload.text
  });

  const history = await getRecentChatHistory(pool, payload.chatId, 12);
  const generatedAnswer = await buildAnswer({
    chatId: payload.chatId,
    history,
    logger,
    openRouterApiKey,
    openRouterModel
  });

  const answer = clampTelegramText(generatedAnswer);

  await retryAsync(
    () =>
      sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: answer
      }),
    {
      attempts: 3,
      baseDelayMs: 500,
      shouldRetry: isRetryableNetworkError
    }
  );

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'assistant',
    content: answer
  });
};

const buildAnswer = async ({
  chatId,
  history,
  logger,
  openRouterApiKey,
  openRouterModel
}: {
  chatId: number;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  logger: AppLogger;
  openRouterApiKey: string;
  openRouterModel: string;
}): Promise<string> => {
  try {
    return await retryAsync(
      () =>
        withTimeout(
          createOpenRouterChatCompletion({
            apiKey: openRouterApiKey,
            model: openRouterModel,
            messages: [
              {
                role: 'system',
                content:
                  'You are a concise Telegram coach assistant. Use short practical replies and keep continuity with recent dialog.'
              },
              ...history
            ]
          }),
          OPENROUTER_TIMEOUT_MS,
          'OpenRouter timeout'
        ),
      {
        attempts: 3,
        baseDelayMs: 800,
        shouldRetry: isRetryableNetworkError
      }
    );
  } catch (error) {
    logger.warn({ err: error, chatId }, 'Falling back due to OpenRouter error');
    return FALLBACK_REPLY;
  }
};

const clampTelegramText = (text: string): string => {
  if (text.length <= TELEGRAM_MESSAGE_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_MESSAGE_MAX_LENGTH - 3)}...`;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const retryAsync = async <T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> => {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < options.attempts) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < options.attempts && options.shouldRetry(error);
      if (!canRetry) {
        throw error;
      }
      const waitMs = options.baseDelayMs * 2 ** (attempt - 1);
      await delay(waitMs);
    }
  }

  throw lastError;
};

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRetryableNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('econnrefused')
  ) {
    return true;
  }

  return /(408|409|425|429|500|502|503|504)/.test(message);
};

void startWorker();