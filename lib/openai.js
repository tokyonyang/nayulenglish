const OPENAI = 'https://api.openai.com/v1';

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) {
    const err = new Error('OPENAI_API_KEY 가 설정되지 않았습니다.');
    err.status = 401; // a missing key is a config problem, not a transient failure — don't let withRetries burn time retrying it
    throw err;
  }
  return k;
}

/** Retries a call on rate limits (429) and transient server/network errors,
 *  with exponential backoff. Vision scanning fires many calls back-to-back,
 *  and a freshly-funded OpenAI account sits on lower per-minute limits —
 *  without this, a 429 partway through a big book just kills that page. */
export async function withRetries(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || status === undefined;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 900 * 2 ** i)); // 900ms, 1.8s
    }
  }
  throw lastErr;
}

export async function chatJSON({ messages, model = 'gpt-4.1-mini', maxTokens = 1400, temperature = 0.7, audio = null }) {
  const body = {
    // gpt-4o-audio-preview (not the mini) — the child's speech is often
    // quiet/mumbly, and the bigger model hears it noticeably more reliably;
    // costs roughly 4x more on the audio portion, but that's still a small
    // absolute amount at this app's usage volume.
    model: audio ? 'gpt-4o-audio-preview' : model,
    messages: audio
      ? [...messages, { role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio.data, format: audio.format || 'wav' } }] }]
      : messages,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: 'json_object' },
  };
  if (audio) body.modalities = ['text']; // hearing the audio is enough — we don't need spoken output back
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenAI ${res.status}: ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '{}';
  const finishReason = data?.choices?.[0]?.finish_reason;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // fall through to the clear error below
      }
    }
    if (finishReason === 'length') {
      throw new Error('책이 너무 길어서 한 번에 정리하지 못했어요. 다시 시도해주세요.');
    }
    throw new Error('AI 응답을 JSON으로 읽지 못했습니다.');
  }
}

export async function speech({ text, instructions, voice = 'coral', model = 'gpt-4o-mini-tts' }) {
  const res = await fetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ model, voice, input: text, instructions, response_format: 'mp3' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${body.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribe({ file, language = 'en' }) {
  const form = new FormData();
  form.append('file', file, file.name || 'audio.webm');
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  const res = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI STT ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.text || '';
}
