import {
  appendChatMessage,
  appendTelegramFeedback,
  appendTelegramReport,
  buildFeedbackInputKeyboard,
  buildModeRecommendationKeyboard,
  createOpenRouterTranscription,
  createDbPool,
  createTelegramDlqQueue,
  createLogger,
  createOpenRouterChatCompletion,
  createTelegramWorker,
  buildMainKeyboard,
  buildModeChangeConfirmKeyboard,
  buildModeKeyboard,
  downloadTelegramFileById,
  enqueueTelegramDlqJob,
  getCoachStrategy,
  isAwaitingFeedbackState,
  isAwaitingModeRecommendationState,
  isBotAboutRequest,
  getOrCreateUserProfile,
  getRecentChatHistory,
  isFeedbackCancelRequest,
  isFeedbackStartRequest,
  isModeChangeCancelRequest,
  isModeChangeConfirmRequest,
  isModeChangeRequest,
  isModeRecommendationCancelRequest,
  isModeRecommendationStartRequest,
  isModeInfoRequest,
  isModeMenuRequest,
  listCoachModes,
  loadConfig,
  parseCoachModeSelection,
  renderFeedbackPromptRu,
  renderHowBotWorksRu,
  renderModeRecommendationPromptRu,
  renderModeDescriptionsRu,
  renderModeInfoSummaryRu,
  runMigrations,
  sendTelegramMessage,
  setAwaitingFeedbackState,
  setAwaitingModeRecommendationState,
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

const OPENROUTER_TRANSCRIBER_TIMEOUT_MS = 20_000;
const OPENROUTER_ANALYZER_TIMEOUT_MS = 35_000;
const OPENROUTER_REPORTER_TIMEOUT_MS = 25_000;
const TELEGRAM_MESSAGE_MAX_LENGTH = 4000;
const FALLBACK_REPLY =
  'Сейчас временно не удалось сформировать ответ. Попробуйте еще раз через 20-30 секунд.';
const FALLBACK_REPLY_TIMEOUT =
  'Сервис сейчас отвечает слишком медленно. Я сохранил контекст, попробуйте повторить сообщение через 20-30 секунд.';
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
        config.OPENROUTER_MODEL_TRANSCRIBER,
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
  transcriberModel: string,
  analyzerModel: string,
  reporterModel: string,
  telegramBotToken: string,
  logger: AppLogger,
  metrics: WorkerMetrics
): Promise<void> => {
  const userInputText = await resolveUserInputText(
    payload,
    telegramBotToken,
    openRouterApiKey,
    transcriberModel,
    logger
  );

  if (isFeedbackStartRequest(userInputText)) {
    await setAwaitingFeedbackState(pool, payload.userId, true);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: renderFeedbackPromptRu(),
      replyMarkup: buildFeedbackInputKeyboard()
    });
    return;
  }

  if (await isAwaitingFeedbackState(pool, payload.userId)) {
    if (isFeedbackCancelRequest(userInputText)) {
      await setAwaitingFeedbackState(pool, payload.userId, false);
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: 'Окей, отменил ввод отзыва.',
        replyMarkup: buildMainKeyboard()
      });
      return;
    }

    const feedbackText = userInputText.trim();
    if (!feedbackText) {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: 'Не вижу текста отзыва. Отправьте, пожалуйста, отзыв одним сообщением.',
        replyMarkup: buildFeedbackInputKeyboard()
      });
      return;
    }

    await appendTelegramFeedback(pool, {
      chatId: payload.chatId,
      userId: payload.userId,
      username: payload.username,
      updateId: payload.updateId,
      message: feedbackText
    });
    await setAwaitingFeedbackState(pool, payload.userId, false);
    logger.info({ chatId: payload.chatId, userId: payload.userId }, 'User feedback saved');
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: 'Спасибо! Отзыв сохранен.',
      replyMarkup: buildMainKeyboard()
    });
    return;
  }

  if (isModeRecommendationStartRequest(userInputText)) {
    await setAwaitingModeRecommendationState(pool, payload.userId, true);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: renderModeRecommendationPromptRu(),
      replyMarkup: buildModeRecommendationKeyboard()
    });
    return;
  }

  if (await isAwaitingModeRecommendationState(pool, payload.userId)) {
    if (isModeRecommendationCancelRequest(userInputText)) {
      await setAwaitingModeRecommendationState(pool, payload.userId, false);
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: 'Окей, отменил подбор режима.',
        replyMarkup: buildMainKeyboard()
      });
      return;
    }

    const brief = userInputText.trim();
    if (brief.length < 8) {
      await sendTelegramMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: 'Нужно чуть больше контекста. Напишите 2-3 коротких предложения.',
        replyMarkup: buildModeRecommendationKeyboard()
      });
      return;
    }

    const recommendation = recommendCoachMode(brief);
    await setAwaitingModeRecommendationState(pool, payload.userId, false);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: [
        `Рекомендую начать с режима: ${recommendation.labelRu} (${recommendation.mode}).`,
        '',
        `Почему: ${recommendation.reason}`,
        '',
        'Если подходит, нажмите кнопку этого режима ниже. Если нет, выберите любой другой.'
      ].join('\n'),
      replyMarkup: buildModeKeyboard()
    });
    return;
  }

  const modeSelection = parseCoachModeSelection(userInputText);
  if (modeSelection) {
    await handleModeSwitchCommand(payload, pool, telegramBotToken, logger, modeSelection);
    return;
  }

  if (isModeChangeRequest(userInputText)) {
    const profile = await getOrCreateUserProfile(pool, payload.userId);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: `${renderModeInfoSummaryRu(profile.coachMode)}\n\nВы нажали "Поменять режим". Это изменит стиль и фокус следующих ответов бота.\n\nТочно хотите открыть выбор режима?`,
      replyMarkup: buildModeChangeConfirmKeyboard()
    });
    return;
  }

  if (isModeChangeConfirmRequest(userInputText) || isModeMenuRequest(userInputText)) {
    const profile = await getOrCreateUserProfile(pool, payload.userId);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: `${renderModeInfoSummaryRu(profile.coachMode)}\n\nВыберите новый режим ниже:`,
      replyMarkup: buildModeKeyboard()
    });
    return;
  }

  if (isModeChangeCancelRequest(userInputText)) {
    const profile = await getOrCreateUserProfile(pool, payload.userId);
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: `Окей, оставляем текущий режим.\n\n${renderModeInfoSummaryRu(profile.coachMode)}`,
      replyMarkup: buildMainKeyboard()
    });
    return;
  }

  if (isModeInfoRequest(userInputText)) {
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: renderModeDescriptionsRu(),
      replyMarkup: buildMainKeyboard()
    });
    return;
  }

  if (isBotAboutRequest(userInputText)) {
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: renderHowBotWorksRu(),
      replyMarkup: buildMainKeyboard()
    });
    return;
  }

  if (userInputText.trim().startsWith('/mode')) {
    const availableModes = listCoachModes().join(', ');
    await sendTelegramMessage({
      botToken: telegramBotToken,
      chatId: payload.chatId,
      text: `Неизвестный режим. Используй /mode <mode>.\nДоступно: ${availableModes}`,
      replyMarkup: buildMainKeyboard()
    });
    return;
  }

  const profile = await getOrCreateUserProfile(pool, payload.userId);
  const strategy = getCoachStrategy(profile.coachMode);

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'user',
    content: userInputText
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
    userText: userInputText,
    analysis,
    reply: answer
  });
};

const resolveUserInputText = async (
  payload: TelegramJobPayload,
  telegramBotToken: string,
  openRouterApiKey: string,
  transcriberModel: string,
  logger: AppLogger
): Promise<string> => {
  if (payload.text && payload.text.trim().length > 0) {
    return payload.text;
  }

  if (!payload.media) {
    throw new Error('Telegram payload has no text or media');
  }

  const startedAtMs = Date.now();
  logger.info(
    {
      chatId: payload.chatId,
      userId: payload.userId,
      mediaKind: payload.media.kind,
      fileId: payload.media.fileId
    },
    'Telegram media transcription started'
  );

  try {
    const downloaded = await downloadTelegramFileById(telegramBotToken, payload.media.fileId);
    const transcription = await withTimeout(
      createOpenRouterTranscription({
        apiKey: openRouterApiKey,
        model: transcriberModel,
        bytes: downloaded.bytes,
        filename: extractFileName(downloaded.filePath),
        mimeType: payload.media.mimeType ?? downloaded.contentType
      }),
      OPENROUTER_TRANSCRIBER_TIMEOUT_MS,
      'OpenRouter transcription timeout'
    );

    logger.info(
      {
        chatId: payload.chatId,
        userId: payload.userId,
        mediaKind: payload.media.kind,
        filePath: downloaded.filePath,
        durationMs: Date.now() - startedAtMs,
        transcriptionChars: transcription.length
      },
      'Telegram media transcribed'
    );

    return transcription;
  } catch (error) {
    logger.warn(
      {
        err: error,
        chatId: payload.chatId,
        userId: payload.userId,
        durationMs: Date.now() - startedAtMs
      },
      'Transcription failed'
    );
    return 'Не удалось распознать аудио. Пожалуйста, отправьте сообщение текстом или более четкое голосовое.';
  }
};

const extractFileName = (filePath: string): string => {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || 'audio.ogg';
};

const recommendCoachMode = (text: string): { mode: CoachMode; labelRu: string; reason: string } => {
  const normalized = text.toLowerCase();

  const scoringRules: Array<{ mode: CoachMode; keywords: string[]; reason: string }> = [
    {
      mode: 'anxiety_grounding',
      keywords: ['тревог', 'паник', 'страх', 'накруч', 'беспокой', 'ужас'],
      reason: 'в сообщении много признаков тревожной спирали и эмоционального перегруза.'
    },
    {
      mode: 'self_sabotage',
      keywords: ['прокраст', 'отклады', 'срыва', 'сабот', 'сливаю', 'не делаю'],
      reason: 'похоже на цикл самосаботажа: есть важные задачи, но действие постоянно блокируется.'
    },
    {
      mode: 'cbt_patterns',
      keywords: ['негатив', 'искажен', 'самокрит', 'вина', 'стыд', 'я всегда', 'я никогда'],
      reason: 'звучат устойчивые негативные мысли и когнитивные искажения, которые лучше разбирать через CBT.'
    },
    {
      mode: 'behavioral_activation',
      keywords: ['апат', 'нет сил', 'устал', 'выгор', 'не хочу ничего', 'нет мотива'],
      reason: 'основная проблема похожа на низкую энергию и потерю импульса к действиям.'
    },
    {
      mode: 'decision_clarity',
      keywords: ['выбор', 'решени', 'вариант', 'дилем', 'сомнева', 'не могу решить'],
      reason: 'в фокусе именно выбор и неопределенность между вариантами.'
    },
    {
      mode: 'post_failure_reset',
      keywords: ['ошибк', 'провал', 'сорвал', 'накосячил', 'облажал', 'срыв'],
      reason: 'контекст похож на состояние после неудачи, где нужен быстрый и бережный перезапуск.'
    },
    {
      mode: 'reality_check',
      keywords: ['факт', 'реальн', 'объектив', 'катастроф', 'преувелич', 'накрутил'],
      reason: 'полезно сначала отделить факты от интерпретаций и снизить искажения восприятия.'
    }
  ];

  let best = { mode: 'reality_check' as CoachMode, score: 0, reason: 'это самый универсальный стартовый режим.' };
  for (const rule of scoringRules) {
    const score = rule.keywords.reduce((acc, keyword) => (normalized.includes(keyword) ? acc + 1 : acc), 0);
    if (score > best.score) {
      best = { mode: rule.mode, score, reason: rule.reason };
    }
  }

  const strategy = getCoachStrategy(best.mode);
  return {
    mode: strategy.mode,
    labelRu: strategy.labelRu,
    reason: best.reason
  };
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
          OPENROUTER_ANALYZER_TIMEOUT_MS,
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
          OPENROUTER_REPORTER_TIMEOUT_MS,
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
    return isTimeoutError(error) ? FALLBACK_REPLY_TIMEOUT : FALLBACK_REPLY;
  }
};

const handleModeSwitchCommand = async (
  payload: TelegramJobPayload,
  pool: DbPool,
  telegramBotToken: string,
  logger: AppLogger,
  mode: CoachMode
): Promise<void> => {
  await setAwaitingModeRecommendationState(pool, payload.userId, false);
  const profile = await setUserCoachMode(pool, payload.userId, mode);
  const strategy = getCoachStrategy(profile.coachMode);
  const response = `Mode updated: ${strategy.label} (${strategy.mode}).`;

  await sendTelegramMessage({
    botToken: telegramBotToken,
    chatId: payload.chatId,
    text: `Режим обновлен: ${strategy.labelRu} (${strategy.mode}).`,
    replyMarkup: buildMainKeyboard()
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

const isTimeoutError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes('timeout');
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
