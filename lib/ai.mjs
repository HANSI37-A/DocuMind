export const aiProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();

const googleApi = 'https://generativelanguage.googleapis.com/v1beta';

function apiKeyError(provider) {
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  const label = provider === 'gemini' ? 'Gemini' : 'OpenAI';
  return new Error(`${label} rejected ${keyName}. Check the key in .env and restart DocuMind.`);
}

async function providerError(response, provider) {
  const detail = await response.json().catch(() => ({}));
  const message = detail.error?.message || '';
  if (provider === 'gemini') {
    const reason = detail.error?.details?.find((item) => item['@type']?.includes('ErrorInfo'))?.reason;
    if (/reported as leaked|known leaked/i.test(message)) {
      return new Error('Google blocked this Gemini key because it was exposed. Create a new key in Google AI Studio, replace GEMINI_API_KEY in .env, and restart DocuMind.');
    }
    if (reason === 'API_KEY_INVALID' || response.status === 401 || /api key not valid|invalid api key|incorrect api key/i.test(message)) {
      return apiKeyError(provider);
    }
    if (response.status === 403) {
      return new Error('Gemini denied access to this project (403). Check the key and project status in Google AI Studio; the key may need Gemini API access or the project may be restricted.');
    }
  } else if (response.status === 401 || /incorrect api key|invalid api key|authentication/i.test(message)) {
    return apiKeyError(provider);
  }
  const safeMessage = process.env.GEMINI_API_KEY ? message.replaceAll(process.env.GEMINI_API_KEY, '[redacted]') : message;
  return new Error(safeMessage || `${provider === 'gemini' ? 'Gemini' : 'OpenAI'} returned ${response.status}.`);
}

async function openAiRequest(path, body) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Add OPENAI_API_KEY to .env to enable OpenAI features.');
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await providerError(response, 'openai');
  return response;
}

async function geminiRequest(path, body) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Add GEMINI_API_KEY to .env to enable Gemini features.');
  const response = await fetch(`${googleApi}/${path}`, {
    method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await providerError(response, 'gemini');
  return response;
}

function normalize(values) {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? values.map((value) => value / magnitude) : values;
}

export async function embedTexts(texts) {
  if (aiProvider === 'gemini') {
    const model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
    const response = await geminiRequest(`models/${model}:batchEmbedContents`, {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: 1536,
      })),
    });
    const result = await response.json();
    return result.embeddings.map((item) => normalize(item.values));
  }

  if (aiProvider !== 'openai') throw new Error('Set AI_PROVIDER to openai or gemini in .env.');
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const response = await openAiRequest('embeddings', { model, input: texts });
  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

export async function streamAnswer(messages) {
  if (aiProvider === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const systemInstruction = messages.find((message) => message.role === 'system')?.content;
    const contents = messages.filter((message) => message.role !== 'system').map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    return geminiRequest(`models/${model}:streamGenerateContent?alt=sse`, {
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents,
    });
  }

  if (aiProvider !== 'openai') throw new Error('Set AI_PROVIDER to openai or gemini in .env.');
  return openAiRequest('chat/completions', {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini', stream: true, messages,
  });
}
