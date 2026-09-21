import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Mints a short-lived ("ephemeral") client secret so the BROWSER can open
// a WebRTC connection directly to OpenAI's Realtime API — our real
// OPENAI_API_KEY never leaves the server. The browser then does its own
// SDP negotiation straight with OpenAI; this route's only job is the
// token + baking the session's behavior in server-side (instructions,
// voice, transcription) so a person poking at the browser network tab
// can't rewrite what the model is told to do.
export async function POST(req) {
  try {
    const { instructions, voice } = await req.json();
    if (!instructions) {
      return NextResponse.json({ error: 'instructions가 없습니다.' }, { status: 400 });
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json({ error: 'OPENAI_API_KEY 가 설정되지 않았습니다.' }, { status: 500 });
    }

    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime-mini',
          instructions,
          audio: {
            input: { transcription: { model: 'whisper-1' } },
            output: { voice: voice || 'coral' },
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json({ error: `OpenAI ${res.status}: ${body.slice(0, 400)}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json({ value: data.value });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
