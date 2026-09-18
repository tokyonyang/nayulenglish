import { NextResponse } from 'next/server';
import { chatJSON } from '@/lib/openai';
import { reportPrompt } from '@/lib/prompts';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req) {
  try {
    const payload = await req.json();
    const data = await chatJSON({
      messages: [{ role: 'user', content: reportPrompt(payload) }],
      maxTokens: 900,
      temperature: 0.7,
    });
    return NextResponse.json(data);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
