import { createHash } from 'crypto';
import { getServerSupabase } from '@/lib/supabaseServer';
import {
  downloadFile,
  ensureFolder,
  findFileInFolder,
  getAccessToken,
  upsertFile,
} from '@/lib/googleDrive';

export const MEDIA_BUCKETS = Object.freeze({
  'book-photos': { folder: 'photos', mimeType: 'image/jpeg' },
  'tts-cache': { folder: 'audio', mimeType: 'audio/mpeg' },
});

function safePath(path) {
  return typeof path === 'string' && path.length <= 180 && !path.startsWith('/') &&
    !path.includes('..') && /^[a-zA-Z0-9._/-]+$/.test(path);
}

export function validateMediaIdentity({ bucket, path, bookId }) {
  if (!MEDIA_BUCKETS[bucket]) throw new Error('지원하지 않는 미디어 종류입니다.');
  if (!safePath(path)) throw new Error('올바르지 않은 미디어 경로입니다.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(bookId || ''))) {
    throw new Error('올바르지 않은 bookId입니다.');
  }

  if (bucket === 'book-photos' && !new RegExp(`^${bookId}/[1-9][0-9]*\\.jpg$`, 'i').test(path)) {
    throw new Error('사진 경로와 bookId가 일치하지 않습니다.');
  }
  if (bucket === 'tts-cache' && !/^[0-9a-f]{40}\.mp3$/i.test(path)) {
    throw new Error('올바르지 않은 음성 캐시 경로입니다.');
  }
}

function basename(path) {
  return path.split('/').pop();
}

async function findBook(supabase, bookId) {
  const { data, error } = await supabase.from('books').select('*').eq('id', bookId).single();
  if (error || !data) throw new Error('책 정보를 찾지 못했습니다.');
  return data;
}

/** Gets stable per-book Drive folders. IDs are cached on the book row, but
 *  the function remains compatible with a database that has not yet cached
 *  them by re-discovering deterministic folder names. */
export async function getDriveFolders(bookId, token) {
  const supabase = getServerSupabase();
  const book = await findBook(supabase, bookId);
  if (book.drive_photos_folder_id && book.drive_audio_folder_id) {
    return {
      bookFolderId: book.drive_book_folder_id || null,
      photosFolderId: book.drive_photos_folder_id,
      audioFolderId: book.drive_audio_folder_id,
    };
  }

  const rootId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_BACKUP_FOLDER_ID 환경변수가 설정되지 않았습니다.');
  const bookFolderName = `${(book.title || 'Untitled').slice(0, 80)} (${bookId.slice(0, 8)})`;
  const bookFolderId = await ensureFolder({ name: bookFolderName, parentId: rootId, token });
  const photosFolderId = await ensureFolder({ name: 'photos', parentId: bookFolderId, token });
  const audioFolderId = await ensureFolder({ name: 'audio', parentId: bookFolderId, token });

  const { error } = await supabase.from('books').update({
    drive_book_folder_id: bookFolderId,
    drive_photos_folder_id: photosFolderId,
    drive_audio_folder_id: audioFolderId,
  }).eq('id', bookId);
  if (error) console.warn('Drive 폴더 ID 저장 실패:', error.message);
  return { bookFolderId, photosFolderId, audioFolderId };
}

async function upsertAssetMetadata(supabase, row) {
  const { error } = await supabase.from('media_assets').upsert(row, {
    onConflict: 'book_id,bucket,object_path',
  });
  if (error) console.warn('미디어 원본 정보 저장 실패:', error.message);
}

export async function storeDurableMedia({ bucket, path, bookId, mimeType, buffer }) {
  validateMediaIdentity({ bucket, path, bookId });
  const supabase = getServerSupabase();
  const token = await getAccessToken();
  const folders = await getDriveFolders(bookId, token);
  const folderId = bucket === 'book-photos' ? folders.photosFolderId : folders.audioFolderId;
  // Never reflect a caller-provided MIME type into a response header.
  // Each supported bucket has one fixed media format.
  const resolvedType = MEDIA_BUCKETS[bucket].mimeType;
  const driveFile = await upsertFile({
    name: basename(path), folderId, token, mimeType: resolvedType, buffer,
  });

  let cacheStatus = 'cached';
  const { error: cacheError } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType: resolvedType, upsert: true });
  if (cacheError) {
    cacheStatus = 'missing';
    console.warn('Supabase 캐시 저장 실패:', cacheError.message);
  }

  await upsertAssetMetadata(supabase, {
    book_id: bookId,
    bucket,
    object_path: path,
    drive_file_id: driveFile.id,
    drive_folder_id: folderId,
    mime_type: resolvedType,
    byte_size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    cache_status: cacheStatus,
    last_cache_at: cacheStatus === 'cached' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });

  return { driveFileId: driveFile.id, cacheStatus, created: driveFile.created };
}

async function cachedMedia(supabase, bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    mimeType: data.type || MEDIA_BUCKETS[bucket].mimeType,
    source: 'supabase',
  };
}

async function metadataFor(supabase, { bucket, path, bookId }) {
  const { data } = await supabase.from('media_assets')
    .select('*')
    .eq('book_id', bookId)
    .eq('bucket', bucket)
    .eq('object_path', path)
    .maybeSingle();
  return data || null;
}

/** Read-through cache: Supabase is checked first. On a miss, the durable
 *  Drive original is downloaded, returned immediately, and written back to
 *  Supabase so the next read is fast. */
export async function readMedia({ bucket, path, bookId }) {
  validateMediaIdentity({ bucket, path, bookId });
  const supabase = getServerSupabase();
  const cached = await cachedMedia(supabase, bucket, path);
  if (cached) return cached;

  const token = await getAccessToken();
  let asset = await metadataFor(supabase, { bucket, path, bookId });
  if (!asset?.drive_file_id) {
    const folders = await getDriveFolders(bookId, token);
    const folderId = bucket === 'book-photos' ? folders.photosFolderId : folders.audioFolderId;
    const found = await findFileInFolder({ name: basename(path), folderId, token });
    if (!found?.id) return null;
    asset = {
      book_id: bookId,
      bucket,
      object_path: path,
      drive_file_id: found.id,
      drive_folder_id: folderId,
      mime_type: found.mimeType || MEDIA_BUCKETS[bucket].mimeType,
    };
  }

  let downloaded;
  try {
    downloaded = await downloadFile({ fileId: asset.drive_file_id, token });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const resolvedType = asset.mime_type || downloaded.mimeType || MEDIA_BUCKETS[bucket].mimeType;
  const { error: cacheError } = await supabase.storage
    .from(bucket)
    .upload(path, downloaded.buffer, { contentType: resolvedType, upsert: true });

  await upsertAssetMetadata(supabase, {
    ...asset,
    mime_type: resolvedType,
    byte_size: downloaded.buffer.length,
    sha256: createHash('sha256').update(downloaded.buffer).digest('hex'),
    cache_status: cacheError ? 'missing' : 'cached',
    last_cache_at: cacheError ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return { buffer: downloaded.buffer, mimeType: resolvedType, source: 'drive' };
}
