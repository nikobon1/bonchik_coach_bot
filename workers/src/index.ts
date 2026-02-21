import {
  appendChatMessage,
  appendTelegramReport,
  createDbPool,
  createTelegramDlqQueue,
  createLogger,
  createOpenRouterChatCompletion,
  createTelegramWorker,
  buildModeKeyboard,
  enqueueTelegramDlqJob,
  getCoachStrategy,
  getOrCreateUserProfile,
  getRecentChatHistory,
  isModeInfoRequest,
  isModeMenuRequest,
  listCoachModes,
  loadConfig,
  parseCoachModeSelection,
  renderModeDescriptionsRu,
  renderModeInfoSummaryRu,
  runMigrations,
  sendTelegramMessage,
  setUserCoachMode,
  type TelegramJobContext,
  type CoachMode,
  type TelegramJobPayload
} from '@bonchik/shared';

type DbPool = ReturnType<typeof createDbPool>;
type AppLogger = ReturnType<typeof createLogger>;
type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
};
type WorkerMetrics = {
  processed: number;
  succeeded: number;
  failed: number;
  openRouterRetries: number;
  telegramRetries: number;
  fallbacks: number;
  dlqPushed: number;
};

const OPENROUTER_TIMEOUT_MS = 20_000;
const TELEGRAM_MESSAGE_MAX_LENGTH = 4000;
const FALLBACK_REPLY =
  'Sorry, I could not process that request right now. Please try again in a few seconds.';
const METRICS_SNAPSHOT_INTERVAL_MS = 60_000;

const startWorker = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('worker');
  const metrics = createInitialMetrics();
  const pool = createDbPool(config.DATABASE_URL);
  const dlqQueue = createTelegramDlqQueue(config.REDIS_URL);
  await runMigrations(pool);

  const worker = createTelegramWorker(config.REDIS_URL, logger, async (payload, context) => {
    const correlation = toCorrelation(payload, context);
    metrics.processed += 1;
    logger.info(correlation, 'Job started');

    try {
      await processTelegramJob(
        payload,
        context,
        pool,
        config.OPENROUTER_API_KEY,
        config.OPENROUTER_MODEL_ANALYZER,
        config.OPENROUTER_MODEL_REPORTER,
        config.TELEGRAM_BOT_TOKEN,
        logger,
        metrics
      );
      metrics.succeeded += 1;
      logger.info(correlation, 'Job succeeded');
    } catch (error) {
      metrics.failed += 1;
      await enqueueTelegramDlqJob(dlqQueue, {
        originalJobId: correlation.jobId,
        originalQueue: correlation.queue,
        attemptsMade: context.attemptsMade,
        failedAt: new Date().toISOString(),
        errorMessage: formatErrorMessage(error),
        payload
      });
      metrics.dlqPushed += 1;
      logger.error({ err: error, ...correlation }, 'Job failed');
      throw error;
    }
  });

  const metricsInterval = setInterval(() => {
    logMetricsSnapshot(logger, metrics);
  }, METRICS_SNAPSHOT_INTERVAL_MS);
  metricsInterval.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    clearInterval(metricsInterval);
    logMetricsSnapshot(logger, metrics);
    await worker.close();
    await Promise.all([pool.end(), dlqQueue.close()]);
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
  context: TelegramJobContext,
  pool: DbPool,
  openRouterApiKey: string,
  analyzerModel: string,
  reporterModel: string,
  telegramBotToken: string,
  logger: AppLogger,
  metrics: WorkerMetrics
): Promise<void> => {
  if (isModeMenuRequest(payload.text) || isModeInfoRequest(payload.text) || payload.text.trim().startsWith('/mode')) {
    const profile = await getOrCreateUserProfile(pool, payload.userId);
    const modeSelection = parseCoachModeSelection(payload.text);
    const availableModes = listCoachModes().join(', ');

    if (isModeMenuRequest(payload.text)) {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: renderModeInfoSummaryRu(profile.coachMode),
        replyMarkup: buildModeKeyboard()
      });
      return;
    }

    if (isModeInfoRequest(payload.text)) {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: renderModeDescriptionsRu(),
        replyMarkup: buildModeKeyboard()
      });
      return;
    }

    if (!modeSelection) {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: `Неизвестный режим. Используй /mode <mode>.\nДоступно: ${availableModes}`,
        replyMarkup: buildModeKeyboard()
      });
      return;
    }

    await handleModeSwitchCommand(payload, pool, telegramBotToken, logger, modeSelection);
    return;
  }

  const profile = await getOrCreateUserProfile(pool, payload.userId);
  const strategy = getCoachStrategy(profile.coachMode);

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'user',
    content: payload.text
  });

  const history = await getRecentChatHistory(pool, payload.chatId, 12);
  const analysis = await buildAnalysis({
    strategyMode: strategy.mode,
    chatId: payload.chatId,
    context,
    history,
    logger,
    metrics,
    openRouterApiKey,
    analyzerModel,
    analyzerSystemPrompt: strategy.analyzerSystemPrompt
  });

  const generatedAnswer = await buildAnswer({
    strategyMode: strategy.mode,
    chatId: payload.chatId,
    context,
    analysis,
    history,
    logger,
    metrics,
    openRouterApiKey,
    reporterModel,
    reporterSystemPrompt: strategy.reporterSystemPrompt
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
      shouldRetry: isRetryableNetworkError,
      onRetry: (error, attempt, waitMs) => {
        metrics.telegramRetries += 1;
        logger.warn(
          {
            err: error,
            ...toCorrelation(payload, context),
            attempt,
            waitMs
          },
          'Retrying Telegram send'
        );
      }
    }
  );

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'assistant',
    content: answer
  });

  await appendTelegramReport(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    updateId: payload.updateId,
    coachMode: strategy.mode,
    analyzerModel,
    reporterModel,
    userText: payload.text,
    analysis,
    reply: answer
  });
};

const buildAnalysis = async ({
  strategyMode,
  chatId,
  context,
  history,
  logger,
  metrics,
  openRouterApiKey,
  analyzerModel,
  analyzerSystemPrompt
}: {
  strategyMode: CoachMode;
  chatId: number;
  context: TelegramJobContext;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  logger: AppLogger;
  metrics: WorkerMetrics;
  openRouterApiKey: string;
  analyzerModel: string;
  analyzerSystemPrompt: string;
}): Promise<string> => {
  try {
    return await retryAsync(
      () =>
        withTimeout(
          createOpenRouterChatCompletion({
            apiKey: openRouterApiKey,
            model: analyzerModel,
            messages: [
              {
                role: 'system',
                content: analyzerSystemPrompt
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
        shouldRetry: isRetryableNetworkError,
        onRetry: (error, attempt, waitMs) => {
          metrics.openRouterRetries += 1;
          logger.warn(
            {
              err: error,
              strategyMode,
              chatId,
              context,
              attempt,
              waitMs
            },
            'Retrying OpenRouter analyzer request'
          );
        }
      }
    );
  } catch (error) {
    metrics.fallbacks += 1;
    logger.warn({ err: error, chatId, context }, 'Falling back due to analyzer error');
    return 'Analysis unavailable due to transient upstream issue.';
  }
};

const buildAnswer = async ({
  strategyMode,
  chatId,
  context,
  analysis,
  history,
  logger,
  metrics,
  openRouterApiKey,
  reporterModel,
  reporterSystemPrompt
}: {
  strategyMode: CoachMode;
  chatId: number;
  context: TelegramJobContext;
  analysis: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  logger: AppLogger;
  metrics: WorkerMetrics;
  openRouterApiKey: string;
  reporterModel: string;
  reporterSystemPrompt: string;
}): Promise<string> => {
  try {
    return await retryAsync(
      () =>
        withTimeout(
          createOpenRouterChatCompletion({
            apiKey: openRouterApiKey,
            model: reporterModel,
            messages: [
              {
                role: 'system',
                content: `${reporterSystemPrompt}\n\nInternal analysis:\n${analysis}`
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
        shouldRetry: isRetryableNetworkError,
        onRetry: (error, attempt, waitMs) => {
          metrics.openRouterRetries += 1;
          logger.warn(
            {
              err: error,
              strategyMode,
              chatId,
              context,
              attempt,
              waitMs
            },
            'Retrying OpenRouter reporter request'
          );
        }
      }
    );
  } catch (error) {
    metrics.fallbacks += 1;
    logger.warn({ err: error, chatId, context }, 'Falling back due to OpenRouter error');
    return FALLBACK_REPLY;
  }
};

const handleModeSwitchCommand = async (
  payload: TelegramJobPayload,
  pool: DbPool,
  telegramBotToken: string,
  logger: AppLogger,
  mode: CoachMode
): Promise<void> => {
  const profile = await setUserCoachMode(pool, payload.userId, mode);
  const strategy = getCoachStrategy(profile.coachMode);
  const response = `Mode updated: ${strategy.label} (${strategy.mode}).`;

  await sendTelegramMessage({
    botToken: telegramBotToken,
    chatId: payload.chatId,
    text: `Режим обновлен: ${strategy.labelRu} (${strategy.mode}).`,
    replyMarkup: buildModeKeyboard()
  });

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'assistant',
    content: response
  });

  logger.info({ chatId: payload.chatId, userId: payload.userId, mode: strategy.mode }, 'User coach mode updated');
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
      options.onRetry?.(error, attempt, waitMs);
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

const createInitialMetrics = (): WorkerMetrics => ({
  processed: 0,
  succeeded: 0,
  failed: 0,
  openRouterRetries: 0,
  telegramRetries: 0,
  fallbacks: 0,
  dlqPushed: 0
});

const logMetricsSnapshot = (logger: AppLogger, metrics: WorkerMetrics): void => {
  logger.info(
    {
      metrics: {
        processed: metrics.processed,
        succeeded: metrics.succeeded,
        failed: metrics.failed,
        openRouterRetries: metrics.openRouterRetries,
        telegramRetries: metrics.telegramRetries,
        fallbacks: metrics.fallbacks,
        dlqPushed: metrics.dlqPushed
      }
    },
    'Worker metrics snapshot'
  );
};

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown worker error';
};

const toCorrelation = (
  payload: TelegramJobPayload,
  context: TelegramJobContext
): { jobId: string; queue: string; chatId: number; userId: number } => ({
  jobId: context.jobId,
  queue: context.queue,
  chatId: payload.chatId,
  userId: payload.userId
});

void startWorker();
