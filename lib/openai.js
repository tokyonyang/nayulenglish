const OPENAI = 'https://api.openai.com/v1';

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY 가 설정되지 않았습니다.');
  return k;
}

export async function chatJSON({ messages, model = 'gpt-4.1-mini', maxTokens = 1400, temperature = 0.7 }) {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 400)}`);
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
  form.append('file', file, 'audio.webm');
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
