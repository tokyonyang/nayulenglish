import { NextResponse } from 'next/server';
import { getAccessToken, ensureFolder } from '@/lib/googleDrive';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req) {
  try {
    const { bookId, bookTitle } = await req.json();
    if (!bookId) return NextResponse.json({ error: 'bookId가 없습니다.' }, { status: 400 });

    const rootId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
    if (!rootId) throw new Error('GOOGLE_DRIVE_BACKUP_FOLDER_ID 환경변수가 설정되지 않았습니다.');

    const token = await getAccessToken();
    const bookFolderName = `${(bookTitle || 'Untitled').slice(0, 80)} (${bookId.slice(0, 8)})`;
    const bookFolderId = await ensureFolder({ name: bookFolderName, parentId: rootId, token });
    const photosFolderId = await ensureFolder({ name: 'photos', parentId: bookFolderId, token });
    const audioFolderId = await ensureFolder({ name: 'audio', parentId: bookFolderId, token });

    return NextResponse.json({ photosFolderId, audioFolderId });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
