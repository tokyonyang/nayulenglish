import { NextResponse } from 'next/server';
import { storeDurableMedia } from '@/lib/mediaStore';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: '저장할 파일이 없습니다.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: '파일은 15MB 이하여야 합니다.' }, { status: 413 });
    }
    const result = await storeDurableMedia({
      bucket: String(form.get('bucket') || ''),
      path: String(form.get('path') || ''),
      bookId: String(form.get('bookId') || ''),
      mimeType: file.type || String(form.get('mimeType') || ''),
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = String(error.message || error);
    const status = /올바르지|지원하지|일치하지/.test(message)
      ? 400
      : /책 정보를 찾지/.test(message) ? 404 : 500;
    if (status >= 500) console.error(error);
    return NextResponse.json({ error: message }, { status });
  }
}
