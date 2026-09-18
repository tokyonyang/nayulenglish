import { NextResponse } from 'next/server';
import { transcribe } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  try {
    const form = await req.formData();
    const audio = form.get('audio');
    const language = form.get('language') || 'en';
    if (!audio || typeof audio !== 'object') {
      return NextResponse.json({ error: '음성이 없습니다.' }, { status: 400 });
    }
    const text = await transcribe({ file: audio, language });
    return NextResponse.json({ text });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
