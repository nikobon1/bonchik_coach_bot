export type OpenRouterChatInput = {
  apiKey: string;
  model: string;
  messages: OpenRouterChatMessage[];
};

export type OpenRouterChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type OpenRouterTranscriptionResponse = {
  text?: string;
};

export const createOpenRouterChatCompletion = async ({
  apiKey,
  model,
  messages
}: OpenRouterChatInput): Promise<string> => {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as OpenRouterChatResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  return content;
};

export type OpenRouterTranscriptionInput = {
  apiKey: string;
  model: string;
  bytes: ArrayBuffer;
  filename: string;
  mimeType?: string | null;
};

export const createOpenRouterTranscription = async ({
  apiKey,
  model,
  bytes,
  filename,
  mimeType
}: OpenRouterTranscriptionInput): Promise<string> => {
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([bytes], { type: mimeType ?? 'audio/ogg' }), filename);

  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter transcription failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as OpenRouterTranscriptionResponse;
  const text = data.text?.trim();
  if (!text) {
    throw new Error('OpenRouter transcription returned empty text');
  }

  return text;
};
