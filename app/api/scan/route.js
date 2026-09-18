import { NextResponse } from 'next/server';
import { chatJSON, withRetries } from '@/lib/openai';
import { spreadExtractionPrompt } from '@/lib/prompts';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('photos').filter((f) => typeof f === 'object' && f.size > 0);
    const start = Math.max(1, parseInt(form.get('start'), 10) || 1);
    if (!files.length) {
      return NextResponse.json({ error: '사진이 없습니다.' }, { status: 400 });
    }

    const spreads = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const num = start + i;
      const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
      const type = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
      try {
        const data = await withRetries(() => chatJSON({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: spreadExtractionPrompt(num) },
                { type: 'image_url', image_url: { url: `data:${type};base64,${b64}`, detail: 'high' } },
              ],
            },
          ],
          maxTokens: 700,
          temperature: 0.2,
        }));
        spreads.push({
          number: num,
          englishText: String(data?.englishText || ''),
          sceneDescription: String(data?.sceneDescription || ''),
          textUncertain: Boolean(data?.textUncertain),
          detectedPage: Number.isFinite(Number(data?.printedPageNumber)) ? Number(data.printedPageNumber) : null,
          error: null,
        });
      } catch (e) {
        console.error('scan spread', num, e);
        spreads.push({
          number: num,
          englishText: '',
          sceneDescription: '',
          textUncertain: true,
          detectedPage: null,
          error: String(e.message || e).slice(0, 200),
        });
      }
    }
    return NextResponse.json({ spreads });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
