export type TelegramSendMessageInput = {
  botToken: string;
  chatId: number;
  text: string;
};

export type TelegramWebhookInput = {
  botToken: string;
  appUrl: string;
};

export const sendTelegramMessage = async ({ botToken, chatId, text }: TelegramSendMessageInput): Promise<void> => {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }
};

export const setTelegramWebhook = async ({ botToken, appUrl }: TelegramWebhookInput): Promise<void> => {
  const webhookUrl = `${appUrl.replace(/\/$/, '')}/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      url: webhookUrl
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram setWebhook failed (${response.status}): ${body}`);
  }
};
