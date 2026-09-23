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
// Realtime voice-to-voice models support a DIFFERENT, smaller set of
// voices than the regular TTS API our other voice picker uses — fable,
// juniper, onyx and nova all exist there but aren't valid here, and
// would fail the session with a 400. Map anything outside this set to a
// safe fallback rather than passing the parent's regular pick through
// unchecked.
const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

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
    const realtimeVoice = REALTIME_VOICES.includes(voice) ? voice : 'coral';

    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime-mini',
          instructions,
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              // Realtime's own default (server_vad, 500ms of silence = "she's
              // done") is far too quick for a 4-year-old who pauses mid-
              // thought — that's exactly why live mode felt rushed and kept
              // jumping in. semantic_vad with low eagerness judges from what
              // she's actually said whether she sounds finished or just
              // trailing off, and waits longer in the latter case, instead
              // of a single fixed timer.
              turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
            },
            output: { voice: realtimeVoice },
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
