import { NextResponse } from 'next/server';
import { storeDurableMedia } from '@/lib/mediaStore';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Only ever fetch from our own Supabase project — this route accepts a
// URL and re-uploads it, so without this check it would be an open proxy.
function isAllowedSource(url) {
  try {
    const supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
    return new URL(url).origin === supabaseOrigin;
  } catch {
    return false;
  }
}

export async function POST(req) {
  try {
    const { bookId, bucket, path, sourceUrl, mimeType } = await req.json();
    if (!bookId || !bucket || !path || !sourceUrl) {
      return NextResponse.json({ error: '필수 값이 없습니다.' }, { status: 400 });
    }
    if (!isAllowedSource(sourceUrl)) {
      return NextResponse.json({ error: '허용되지 않은 원본 주소입니다.' }, { status: 400 });
    }

    const fileRes = await fetch(sourceUrl);
    if (!fileRes.ok) return NextResponse.json({ error: `원본을 찾지 못했습니다 (${fileRes.status})` }, { status: 404 });
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const result = await storeDurableMedia({
      bookId,
      bucket,
      path,
      mimeType: mimeType || fileRes.headers.get('content-type') || 'application/octet-stream',
      buffer,
    });
    return NextResponse.json({ created: result.created, updated: !result.created });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
