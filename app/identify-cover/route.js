import { NextResponse } from 'next/server';
import { chatJSON, withRetries } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('cover');
    if (!file || typeof file !== 'object') {
      return NextResponse.json({ error: '표지 사진이 없습니다.' }, { status: 400 });
    }
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    const type = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';

    const data = await withRetries(() => chatJSON({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Look at this children's picture book cover. Identify the book as precisely as you can from what's printed on the cover and, if you recognize the book itself, your own knowledge of it.

Reply with ONLY this JSON object:
{"title": "the book's title exactly as printed on the cover", "author": "the author's name as printed, or your best-known author for this book if not clearly printed; empty string if genuinely unknown", "series": "the series name if this book is part of one (e.g. 'Elephant & Piggie'), empty string if it's a standalone book or you're not sure"}`,
            },
            { type: 'image_url', image_url: { url: `data:${type};base64,${b64}`, detail: 'high' } },
          ],
        },
      ],
      maxTokens: 300,
      temperature: 0.2,
    }));

    return NextResponse.json({
      title: String(data?.title || ''),
      author: String(data?.author || ''),
      series: String(data?.series || ''),
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
