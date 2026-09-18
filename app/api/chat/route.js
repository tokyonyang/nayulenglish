import { NextResponse } from 'next/server';
import { chatJSON } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { instructions, turns } = await req.json();
    const messages = [{ role: 'system', content: instructions }, ...(turns || [])];
    const data = await chatJSON({ messages, maxTokens: 500, temperature: 0.8 });
    return NextResponse.json(data);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
