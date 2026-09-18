import { NextResponse } from 'next/server';
import { chatJSON, transcribe, withRetries } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { instructions, turns, audio } = await req.json();
    const messages = [{ role: 'system', content: instructions }, ...(turns || [])];

    let data;
    if (audio?.data) {
      try {
        data = await withRetries(() => chatJSON({ messages, maxTokens: 500, temperature: 0.8, audio }));
      } catch (e) {
        // The audio-hearing model is a preview and occasionally misbehaves
        // on structured JSON — fall back to the reliable Whisper+text path
        // rather than leaving the child mid-conversation with an error.
        console.error('audio chat failed, falling back to whisper+text', e);
        const buf = Buffer.from(audio.data, 'base64');
        const file = new File([buf], 'speech.wav', { type: 'audio/wav' });
        const text = (await transcribe({ file, language: 'en' })).trim();
        const fallbackMessages = [...messages, { role: 'user', content: text || '(...)' }];
        data = await withRetries(() => chatJSON({ messages: fallbackMessages, maxTokens: 500, temperature: 0.8 }));
        if (!data.childTranscript) data.childTranscript = text;
      }
    } else {
      data = await withRetries(() => chatJSON({ messages, maxTokens: 500, temperature: 0.8 }));
    }

    return NextResponse.json(data);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
