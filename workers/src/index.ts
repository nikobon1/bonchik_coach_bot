import {
  createLogger,
  createOpenRouterChatCompletion,
  createTelegramWorker,
  loadConfig,
  sendTelegramMessage,
  type TelegramJobPayload
} from '@bonchik/shared';

const startWorker = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger('worker');
  const worker = createTelegramWorker(config.REDIS_URL, logger, async (payload) =>
    processTelegramJob(payload, config.OPENROUTER_API_KEY, config.OPENROUTER_MODEL_REPORTER, config.TELEGRAM_BOT_TOKEN)
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
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
  openRouterApiKey: string,
  openRouterModel: string,
  telegramBotToken: string
): Promise<void> => {
  const answer = await createOpenRouterChatCompletion({
    apiKey: openRouterApiKey,
    model: openRouterModel,
    systemPrompt:
      'You are a concise Telegram coach assistant. Respond in plain text, clear and practical.',
    prompt: payload.text
  });

  await sendTelegramMessage({
    botToken: telegramBotToken,
    chatId: payload.chatId,
    text: answer
  });
};

void startWorker();
