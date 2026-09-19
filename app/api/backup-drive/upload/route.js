import { NextResponse } from 'next/server';
import { getAccessToken, fileExistsInFolder, uploadFile } from '@/lib/googleDrive';

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
    const { folderId, filename, sourceUrl, mimeType } = await req.json();
    if (!folderId || !filename || !sourceUrl) {
      return NextResponse.json({ error: '필수 값이 없습니다.' }, { status: 400 });
    }
    if (!isAllowedSource(sourceUrl)) {
      return NextResponse.json({ error: '허용되지 않은 원본 주소입니다.' }, { status: 400 });
    }

    const token = await getAccessToken();

    const already = await fileExistsInFolder({ name: filename, folderId, token });
    if (already) return NextResponse.json({ skipped: true });

    const fileRes = await fetch(sourceUrl);
    if (!fileRes.ok) return NextResponse.json({ error: `원본을 찾지 못했습니다 (${fileRes.status})` }, { status: 404 });
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    await uploadFile({
      name: filename,
      mimeType: mimeType || fileRes.headers.get('content-type') || 'application/octet-stream',
      buffer,
      folderId,
      token,
    });
    return NextResponse.json({ uploaded: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
