export type TelegramSendMessageInput = {
  botToken: string;
  chatId: number;
  text: string;
  replyMarkup?: unknown;
};

export type TelegramChatAction = 'typing';

export type TelegramSendChatActionInput = {
  botToken: string;
  chatId: number;
  action: TelegramChatAction;
};

export type TelegramWebhookInput = {
  botToken: string;
  appUrl: string;
  secretToken?: string;
};

export type TelegramDownloadedFile = {
  filePath: string;
  bytes: ArrayBuffer;
  contentType: string | null;
};

const TELEGRAM_API_TIMEOUT_MS = 15_000;
const TELEGRAM_FILE_TIMEOUT_MS = 20_000;

export const sendTelegramMessage = async ({
  botToken,
  chatId,
  text,
  replyMarkup
}: TelegramSendMessageInput): Promise<void> => {
  const response = await withTelegramTimeout(
    (signal) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: replyMarkup
        })
      }),
    TELEGRAM_API_TIMEOUT_MS,
    'Telegram sendMessage'
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }
};

export const sendTelegramChatAction = async ({
  botToken,
  chatId,
  action
}: TelegramSendChatActionInput): Promise<void> => {
  const response = await withTelegramTimeout(
    (signal) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          action
        })
      }),
    TELEGRAM_API_TIMEOUT_MS,
    'Telegram sendChatAction'
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendChatAction failed (${response.status}): ${body}`);
  }
};

export const setTelegramWebhook = async ({ botToken, appUrl, secretToken }: TelegramWebhookInput): Promise<void> => {
  const webhookUrl = `${appUrl.replace(/\/$/, '')}/telegram/webhook`;
  const response = await withTelegramTimeout(
    (signal) =>
      fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secretToken
        })
      }),
    TELEGRAM_API_TIMEOUT_MS,
    'Telegram setWebhook'
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram setWebhook failed (${response.status}): ${body}`);
  }
};

type TelegramGetFileResponse = {
  ok: boolean;
  result?: {
    file_path?: string;
  };
  description?: string;
};

export const downloadTelegramFileById = async (
  botToken: string,
  fileId: string
): Promise<TelegramDownloadedFile> => {
  const getFileResponse = await withTelegramTimeout(
    (signal) =>
      fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          file_id: fileId
        })
      }),
    TELEGRAM_API_TIMEOUT_MS,
    'Telegram getFile'
  );

  if (!getFileResponse.ok) {
    const body = await getFileResponse.text();
    throw new Error(`Telegram getFile failed (${getFileResponse.status}): ${body}`);
  }

  const getFileData = (await getFileResponse.json()) as TelegramGetFileResponse;
  const filePath = getFileData.result?.file_path;
  if (!getFileData.ok || !filePath) {
    throw new Error(`Telegram getFile failed: ${getFileData.description ?? 'missing file_path'}`);
  }

  const downloadResponse = await withTelegramTimeout(
    (signal) => fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { signal }),
    TELEGRAM_FILE_TIMEOUT_MS,
    'Telegram file download'
  );
  if (!downloadResponse.ok) {
    const body = await downloadResponse.text();
    throw new Error(`Telegram file download failed (${downloadResponse.status}): ${body}`);
  }

  return {
    filePath,
    bytes: await downloadResponse.arrayBuffer(),
    contentType: downloadResponse.headers.get('content-type')
  };
};

const withTelegramTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  timeout.unref?.();

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const isAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
};
