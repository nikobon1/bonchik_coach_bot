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
      config.TELEGRAM_BOT_TOKEN
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
  telegramBotToken: string
): Promise<void> => {
  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'user',
    content: payload.text
  });

  const history = await getRecentChatHistory(pool, payload.chatId, 12);
  const answer = await createOpenRouterChatCompletion({
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
  });

  await sendTelegramMessage({
    botToken: telegramBotToken,
    chatId: payload.chatId,
    text: answer
  });

  await appendChatMessage(pool, {
    chatId: payload.chatId,
    userId: payload.userId,
    username: payload.username,
    role: 'assistant',
    content: answer
  });
};

void startWorker();
