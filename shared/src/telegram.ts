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

export const sendTelegramMessage = async ({
  botToken,
  chatId,
  text,
  replyMarkup
}: TelegramSendMessageInput): Promise<void> => {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    })
  });

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
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      action
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendChatAction failed (${response.status}): ${body}`);
  }
};

export const setTelegramWebhook = async ({ botToken, appUrl, secretToken }: TelegramWebhookInput): Promise<void> => {
  const webhookUrl = `${appUrl.replace(/\/$/, '')}/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken
    })
  });

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
  const getFileResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      file_id: fileId
    })
  });

  if (!getFileResponse.ok) {
    const body = await getFileResponse.text();
    throw new Error(`Telegram getFile failed (${getFileResponse.status}): ${body}`);
  }

  const getFileData = (await getFileResponse.json()) as TelegramGetFileResponse;
  const filePath = getFileData.result?.file_path;
  if (!getFileData.ok || !filePath) {
    throw new Error(`Telegram getFile failed: ${getFileData.description ?? 'missing file_path'}`);
  }

  const downloadResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
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
