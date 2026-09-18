import { speech } from '@/lib/openai';
import { ttsInstructions } from '@/lib/prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const VALID_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable',
  'juniper', 'marin', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
]);

export async function POST(req) {
  try {
    const { text, tone, slow, voice, direction } = await req.json();
    if (!text || !String(text).trim()) {
      return new Response('빈 문장입니다.', { status: 400 });
    }
    const audio = await speech({
      text: String(text).slice(0, 1200),
      instructions: ttsInstructions(tone, slow, direction),
      ...(VALID_VOICES.has(voice) ? { voice } : {}),
    });
    return new Response(audio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.error(e);
    return new Response(String(e.message || e), { status: 500 });
  }
}
