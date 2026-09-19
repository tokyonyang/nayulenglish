import { NextResponse } from 'next/server';
import { readMedia } from '@/lib/mediaStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function handle(req, includeBody) {
  try {
    const url = new URL(req.url);
    const identity = {
      bucket: url.searchParams.get('bucket'),
      path: url.searchParams.get('path'),
      bookId: url.searchParams.get('bookId'),
    };
    const media = await readMedia(identity);
    if (!media) return NextResponse.json({ error: '미디어 원본을 찾지 못했습니다.' }, { status: 404 });
    return new NextResponse(includeBody ? media.buffer : null, {
      status: 200,
      headers: {
        'Content-Type': media.mimeType,
        'Content-Length': String(media.buffer.length),
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600',
        'X-Media-Source': media.source,
      },
    });
  } catch (error) {
    const message = String(error.message || error);
    const status = /올바르지|지원하지|일치하지/.test(message)
      ? 400
      : /책 정보를 찾지/.test(message) ? 404 : 500;
    if (status >= 500) console.error(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req) {
  return handle(req, true);
}

export async function HEAD(req) {
  return handle(req, false);
}
