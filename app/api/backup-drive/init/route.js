import { NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/googleDrive';
import { getDriveFolders } from '@/lib/mediaStore';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req) {
  try {
    const { bookId, bookTitle } = await req.json();
    if (!bookId) return NextResponse.json({ error: 'bookId가 없습니다.' }, { status: 400 });

    const token = await getAccessToken();
    const folders = await getDriveFolders(bookId, token);
    return NextResponse.json(folders);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
