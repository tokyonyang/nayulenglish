import { NextResponse } from 'next/server';
import { chatJSON, withRetries } from '@/lib/openai';
import { enrichmentPrompt } from '@/lib/prompts';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req) {
  try {
    const { spreads } = await req.json();
    if (!Array.isArray(spreads) || !spreads.length) {
      return NextResponse.json({ error: '펼침면이 없습니다.' }, { status: 400 });
    }
    const data = await withRetries(() => chatJSON({
      messages: [{ role: 'user', content: enrichmentPrompt(spreads) }],
      // Scale with page count — voiceDirection made each spread's output
      // noticeably longer, so a fixed cap was truncating big books.
      maxTokens: Math.min(12000, 1200 + spreads.length * 260),
      temperature: 0.6,
    }));
    return NextResponse.json(data);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
