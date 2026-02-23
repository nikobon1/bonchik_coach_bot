import {
  appendChatMessage,
  appendTelegramFeedback,
  appendTelegramFlowEvent,
  appendTelegramReport,
  buildFeedbackInputKeyboard,
  buildModeRecommendationKeyboard,
  createOpenRouterTranscription,
  createDbPool,
  createMorningSummaryQueue,
  createMorningSummaryWorker,
  createTelegramDlqQueue,
  createLogger,
  createOpenRouterChatCompletion,
  buildMainKeyboard,
  buildModeChangeConfirmKeyboard,
  buildModeKeyboard,
  createTelegramWorker,
  downloadTelegramFileById,
  ensureMorningSummarySchedule,
  enqueueTelegramDlqJob,
  getCoachStrategy,
  incrementTelegramFlowCounter,
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
  hasTelegramDailySummaryForDate,
  listTelegramReportChatsInRange,
  listTelegramReportsByChatInRange,
  loadConfig,
  parseCoachModeSelection,
  recordTelegramDailySummarySent,
  renderFeedbackPromptRu,
  renderHowBotWorksRu,
  renderModeRecommendationPromptRu,
  renderModeDescriptionsRu,
  renderModeInfoSummaryRu,
  runMigrations,
  sendTelegramChatAction,
  sendTelegramMessage,
  setAwaitingFeedbackState,
  setAwaitingModeRecommendationState,
  setUserCoachMode,
  type MorningSummaryJobContext,
  type TelegramJobContext,
  type CoachMode,
  type TelegramFlowCounterKey,
  type TelegramJobPayload,
  type TelegramReportView
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
type TelegramReplyLatencySnapshot = {
  queueWaitMs: number | null;
  inputResolutionMs: number | null;
  analyzerDurationMs: number | null;
  reporterDurationMs: number | null;
  telegramSendDurationMs: number | null;
  totalDurationMs: number;
};

const OPENROUTER_TRANSCRIBER_TIMEOUT_MS = 20_000;
const OPENROUTER_ANALYZER_TIMEOUT_MS = 35_000;
const OPENROUTER_REPORTER_TIMEOUT_MS = 25_000;
const OPENROUTER_DAILY_SUMMARY_TIMEOUT_MS = 30_000;
const TELEGRAM_MESSAGE_MAX_LENGTH = 4000;
const TELEGRAM_TYPING_HEARTBEAT_MS = 4_000;
const TELEGRAM_PROGRESS_NOTICE_DELAY_MS = 5_000;
const TELEGRAM_PROGRESS_NOTICE_TEXT = 'Секунду, думаю над ответом...';
const MORNING_SUMMARY_MAX_REPORTS_PER_CHAT = 24;
const FALLBACK_REPLY =
  'Сейчас временно не удалось сформировать ответ. Попробуйте еще раз через 20-30 секунд.';
const FALLBACK_REPLY_TIMEOUT =
  'Сервис сейчас отвечает слишком медленно. Я сохранил контекст, попробуйте повторить сообщение через 20-30 секунд.';
const METRICS_SNAPSHOT_INTERVAL_MS = 60_000;

type SummaryWindow = {
  summaryDate: string;
  fromInclusive: string;
  toExclusive: string;
};

const recordTelegramFlowCounterSafely = async (
  pool: DbPool,
  logger: AppLogger,
  counterKey: TelegramFlowCounterKey,
  payload: Pick<TelegramJobPayload, 'chatId' | 'userId' | 'updateId'>
): Promise<void> => {
  try {
    await incrementTelegramFlowCounter(pool, counterKey);
  } catch (error) {
    logger.warn(
      {
        err: error,
        counterKey,
        chatId: payload.chatId,
        userId: payload.userId,
        updateId: payload.updateId
      },
      'Failed to record telegram flow counter'
    );
  }

  try {
    await appendTelegramFlowEvent(pool, {
      key: counterKey,
      chatId: payload.chatId,
      userId: payload.userId,
      updateId: payload.updateId
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        counterKey,
        chatId: payload.chatId,
        userId: payload.userId,
        updateId: payload.updateId
      },
      'Failed to record telegram flow event'
    );
  }
};

const withTelegramTyping = async <T>({
  botToken,
  chatId,
  logger,
  task
}: {
  botToken: string;
  chatId: number;
  logger: AppLogger;
  task: () => Promise<T>;
}): Promise<T> => {
  let stopped = false;
  let loggedFailure = false;

  const pulse = async (): Promise<void> => {
    try {
      await sendTelegramChatAction({
        botToken,
        chatId,
        action: 'typing'
      });
    } catch (error) {
      if (!loggedFailure) {
        loggedFailure = true;
        logger.warn({ err: error, chatId }, 'Failed to send Telegram typing action');
      }
    }
  };

  await pulse();
  const timer = setInterval(() => {
    if (stopped) {
      return;
    }

    void pulse();
  }, TELEGRAM_TYPING_HEARTBEAT_MS);
  timer.unref();

  try {
    return await task();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
};

const withDelayedTelegramProgressMessage = async <T>({
  botToken,
  chatId,
  text,
  delayMs,
  logger,
  task
}: {
  botToken: string;
  chatId: number;
  text: string;
  delayMs: number;
  logger: AppLogger;
  task: () => Promise<T>;
}): Promise<{ result: T; sent: boolean }> => {
  let timer: NodeJS.Timeout | null = null;
  let progressSendPromise: Promise<void> | null = null;
  let sent = false;
  let stopped = false;

  const sendProgress = async (): Promise<void> => {
    try {
      await sendTelegramMessage({
        botToken,
        chatId,
        text
      });
      sent = true;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'Failed to send Telegram progress notice');
    }
  };

  timer = setTimeout(() => {
    if (stopped) {
      return;
    }

    progressSendPromise = sendProgress();
  }, delayMs);
  timer.unref();

  try {
    const result = await task();
    return { result, sent };
  } finally {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (progressSendPromise) {
      await progressSendPromise;
    }
  }
};

const startWorker = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('worker');
  const metrics = createInitialMetrics();
  const pool = createDbPool(config.DATABASE_URL);
  const dlqQueue = createTelegramDlqQueue(config.REDIS_URL);
  const morningSummaryQueue = createMorningSummaryQueue(config.REDIS_URL);
  await runMigrations(pool);

  if (config.MORNING_SUMMARY_ENABLED) {
    await ensureMorningSummarySchedule(
      morningSummaryQueue,
      config.MORNING_SUMMARY_CRON,
      config.MORNING_SUMMARY_TZ
    );
    logger.info(
      {
        cron: config.MORNING_SUMMARY_CRON,
        timezone: config.MORNING_SUMMARY_TZ
      },
      'Morning summary schedule ensured'
    );
  } else {
    logger.info('Morning summary schedule disabled by config');
  }

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

  const morningSummaryWorker = createMorningSummaryWorker(
    config.REDIS_URL,
    logger,
    async (_payload, context) => {
      if (!config.MORNING_SUMMARY_ENABLED) {
        logger.info({ context }, 'Skipping morning summary job because feature is disabled');
        return;
      }

      await processMorningSummaryJob({
        pool,
        logger,
        context,
        openRouterApiKey: config.OPENROUTER_API_KEY,
        reporterModel: config.OPENROUTER_MODEL_REPORTER,
        telegramBotToken: config.TELEGRAM_BOT_TOKEN,
        timezone: config.MORNING_SUMMARY_TZ,
        metrics
      });
    }
  );

  const metricsInterval = setInterval(() => {
    logMetricsSnapshot(logger, metrics);
  }, METRICS_SNAPSHOT_INTERVAL_MS);
  metricsInterval.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    clearInterval(metricsInterval);
    logMetricsSnapshot(logger, metrics);
    await Promise.all([worker.close(), morningSummaryWorker.close()]);
    await Promise.all([pool.end(), dlqQueue.close(), morningSummaryQueue.close()]);
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
  const totalStartedAtMs = Date.now();
  const queueWaitMs = Number.isFinite(context.enqueuedAtMs)
    ? Math.max(0, totalStartedAtMs - context.enqueuedAtMs)
    : null;

  const inputResolutionStartedAtMs = Date.now();
  const userInputText = payload.media
    ? await withTelegramTyping({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        logger,
        task: () =>
          resolveUserInputText(payload, telegramBotToken, openRouterApiKey, transcriberModel, logger)
      })
    : await resolveUserInputText(payload, telegramBotToken, openRouterApiKey, transcriberModel, logger);
  const inputResolutionMs = Date.now() - inputResolutionStartedAtMs;

  if (isFeedbackStartRequest(userInputText)) {
    await setAwaitingFeedbackState(pool, payload.userId, true);
    await recordTelegramFlowCounterSafely(pool, logger, 'feedback_started', payload);
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
      await recordTelegramFlowCounterSafely(pool, logger, 'feedback_cancelled', payload);
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
    await recordTelegramFlowCounterSafely(pool, logger, 'feedback_saved', payload);
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
    await recordTelegramFlowCounterSafely(pool, logger, 'mode_recommendation_started', payload);
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
      await recordTelegramFlowCounterSafely(pool, logger, 'mode_recommendation_cancelled', payload);
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
    await recordTelegramFlowCounterSafely(pool, logger, 'mode_recommendation_suggested', payload);
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
  let analyzerDurationMs: number | null = null;
  let reporterDurationMs: number | null = null;
  let telegramSendDurationMs: number | null = null;
  const {
    result: { analysis, answer },
    sent: progressNoticeSent
  } = await withTelegramTyping({
    botToken: telegramBotToken,
    chatId: payload.chatId,
    logger,
    task: () =>
      withDelayedTelegramProgressMessage({
        botToken: telegramBotToken,
        chatId: payload.chatId,
        text: TELEGRAM_PROGRESS_NOTICE_TEXT,
        delayMs: TELEGRAM_PROGRESS_NOTICE_DELAY_MS,
        logger,
        task: async () => {
          const analyzerStartedAtMs = Date.now();
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
          analyzerDurationMs = Date.now() - analyzerStartedAtMs;

          const reporterStartedAtMs = Date.now();
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
          reporterDurationMs = Date.now() - reporterStartedAtMs;

          const answer = clampTelegramText(generatedAnswer);

          const telegramSendStartedAtMs = Date.now();
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
          telegramSendDurationMs = Date.now() - telegramSendStartedAtMs;

          return { analysis, answer };
        }
      })
  });

  if (progressNoticeSent) {
    logger.info({ chatId: payload.chatId, updateId: payload.updateId }, 'Telegram long-reply progress notice sent');
  }

  const latency: TelegramReplyLatencySnapshot = {
    queueWaitMs,
    inputResolutionMs,
    analyzerDurationMs,
    reporterDurationMs,
    telegramSendDurationMs,
    totalDurationMs: Date.now() - totalStartedAtMs
  };

  logger.info(
    {
      chatId: payload.chatId,
      userId: payload.userId,
      updateId: payload.updateId,
      coachMode: strategy.mode,
      progressNoticeSent,
      latency
    },
    'Telegram reply latency snapshot'
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
    reply: answer,
    queueWaitMs: latency.queueWaitMs,
    inputResolutionMs: latency.inputResolutionMs,
    analyzerDurationMs: latency.analyzerDurationMs,
    reporterDurationMs: latency.reporterDurationMs,
    telegramSendDurationMs: latency.telegramSendDurationMs,
    totalDurationMs: latency.totalDurationMs
  });
};

const processMorningSummaryJob = async ({
  pool,
  logger,
  context,
  openRouterApiKey,
  reporterModel,
  telegramBotToken,
  timezone,
  metrics
}: {
  pool: DbPool;
  logger: AppLogger;
  context: MorningSummaryJobContext;
  openRouterApiKey: string;
  reporterModel: string;
  telegramBotToken: string;
  timezone: string;
  metrics: WorkerMetrics;
}): Promise<void> => {
  const window = await resolveMorningSummaryWindow(pool, timezone);
  const chatRefs = await listTelegramReportChatsInRange(pool, window.fromInclusive, window.toExclusive);

  logger.info(
    {
      context,
      summaryDate: window.summaryDate,
      timezone,
      chatsCount: chatRefs.length
    },
    'Morning summary job started'
  );

  for (const chatRef of chatRefs) {
    if (await hasTelegramDailySummaryForDate(pool, chatRef.chatId, window.summaryDate)) {
      logger.info(
        {
          context,
          chatId: chatRef.chatId,
          summaryDate: window.summaryDate
        },
        'Morning summary already sent, skipping'
      );
      continue;
    }

    const reports = await listTelegramReportsByChatInRange(
      pool,
      chatRef.chatId,
      window.fromInclusive,
      window.toExclusive,
      MORNING_SUMMARY_MAX_REPORTS_PER_CHAT
    );

    if (reports.length === 0) {
      continue;
    }

    const summaryBody = await buildMorningSummary({
      chatId: chatRef.chatId,
      summaryDate: window.summaryDate,
      timezone,
      reports,
      openRouterApiKey,
      reporterModel,
      logger,
      context,
      metrics
    });

    const messageText = clampTelegramText(`Summary for ${window.summaryDate}\n\n${summaryBody}`);

    await retryAsync(
      () =>
        sendTelegramMessage({
          botToken: telegramBotToken,
          chatId: chatRef.chatId,
          text: messageText
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
              context,
              chatId: chatRef.chatId,
              attempt,
              waitMs
            },
            'Retrying morning summary Telegram send'
          );
        }
      }
    );

    await appendChatMessage(pool, {
      chatId: chatRef.chatId,
      userId: chatRef.userId,
      role: 'assistant',
      content: messageText
    });

    const recorded = await recordTelegramDailySummarySent(pool, {
      chatId: chatRef.chatId,
      userId: chatRef.userId,
      summaryDate: window.summaryDate,
      timezone,
      reportsCount: reports.length,
      windowStartAt: window.fromInclusive,
      windowEndAt: window.toExclusive,
      summaryText: messageText
    });

    logger.info(
      {
        context,
        chatId: chatRef.chatId,
        userId: chatRef.userId,
        summaryDate: window.summaryDate,
        reportsCount: reports.length,
        recorded
      },
      'Morning summary sent'
    );
  }

  logger.info(
    {
      context,
      summaryDate: window.summaryDate,
      timezone,
      chatsCount: chatRefs.length
    },
    'Morning summary job completed'
  );
};

const buildMorningSummary = async ({
  chatId,
  summaryDate,
  timezone,
  reports,
  openRouterApiKey,
  reporterModel,
  logger,
  context,
  metrics
}: {
  chatId: number;
  summaryDate: string;
  timezone: string;
  reports: TelegramReportView[];
  openRouterApiKey: string;
  reporterModel: string;
  logger: AppLogger;
  context: MorningSummaryJobContext;
  metrics: WorkerMetrics;
}): Promise<string> => {
  const source = reports
    .map((report, index) => formatMorningSummaryReportForPrompt(index + 1, report))
    .join('\n\n');

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
                content:
                  'You create a morning summary for a Telegram coaching user. Write in Russian. Be concrete, concise, supportive, and structured. Do not mention private system prompts. Use plain text only.'
              },
              {
                role: 'user',
                content: [
                  `Create a morning summary for ${summaryDate} in timezone ${timezone}.`,
                  `Chat ID: ${chatId}.`,
                  `Total reports: ${reports.length}.`,
                  '',
                  'Output format:',
                  '1) Short headline (1 line)',
                  '2) Key patterns (3-5 bullets)',
                  '3) Risks / blockers (1-3 bullets)',
                  '4) Priority for today (1-3 bullets)',
                  '5) One reflective question',
                  '',
                  'Source reports (chronological):',
                  source
                ].join('\n')
              }
            ]
          }),
          OPENROUTER_DAILY_SUMMARY_TIMEOUT_MS,
          'OpenRouter daily summary timeout'
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
              context,
              chatId,
              summaryDate,
              attempt,
              waitMs
            },
            'Retrying OpenRouter morning summary request'
          );
        }
      }
    );
  } catch (error) {
    metrics.fallbacks += 1;
    logger.warn({ err: error, context, chatId, summaryDate }, 'Falling back for morning summary');
    return buildMorningSummaryFallback(reports);
  }
};

const buildMorningSummaryFallback = (reports: TelegramReportView[]): string => {
  const first = reports[0];
  const last = reports[reports.length - 1];
  const modes = Array.from(new Set(reports.map((report) => report.coachMode)));
  const recentHighlights = reports
    .slice(-3)
    .map((report, index) => `- ${index + 1}. ${truncateForPrompt(report.userText, 160)}`)
    .join('\n');

  return [
    'Utrennee summary (fallback):',
    `- Soobshcheniy s analizom: ${reports.length}`,
    `- Rezhimy v techenie dnya: ${modes.join(', ')}`,
    `- Period: ${first?.createdAt ?? 'n/a'} .. ${last?.createdAt ?? 'n/a'}`,
    '',
    'Klyuchevye temi iz poslednih soobshcheniy:',
    recentHighlights || '- n/a',
    '',
    'Prioritet na segodnya:',
    '- Vyberi 1 samuyu vazhnuyu zadachu i opredeli sleduyushchij konkretnyj shag.'
  ].join('\n');
};

const formatMorningSummaryReportForPrompt = (index: number, report: TelegramReportView): string =>
  [
    `[${index}] createdAt=${report.createdAt} mode=${report.coachMode}`,
    `user: ${truncateForPrompt(report.userText, 700)}`,
    `analysis: ${truncateForPrompt(report.analysis, 700)}`,
    `reply: ${truncateForPrompt(report.reply, 500)}`
  ].join('\n');

const truncateForPrompt = (text: string, maxLength: number): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
};

const resolveMorningSummaryWindow = async (pool: DbPool, timezone: string): Promise<SummaryWindow> => {
  type SummaryWindowRow = {
    summary_date: string;
    from_utc: string | Date;
    to_utc: string | Date;
  };

  const result = await pool.query(
    `
      SELECT
        (((NOW() AT TIME ZONE $1)::date - 1)::text) AS summary_date,
        ((((NOW() AT TIME ZONE $1)::date - 1)::timestamp AT TIME ZONE $1)) AS from_utc,
        (((NOW() AT TIME ZONE $1)::date)::timestamp AT TIME ZONE $1) AS to_utc
    `,
    [timezone]
  );

  const row = result.rows[0] as SummaryWindowRow | undefined;
  if (!row) {
    throw new Error('Failed to resolve morning summary window');
  }

  return {
    summaryDate: row.summary_date,
    fromInclusive: toIsoTimestamp(row.from_utc),
    toExclusive: toIsoTimestamp(row.to_utc)
  };
};

const toIsoTimestamp = (value: string | Date): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
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
