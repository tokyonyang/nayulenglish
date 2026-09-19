const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  return v;
}

/** Exchanges the user's stored refresh token for a short-lived access
 *  token. Uploads made with this token are owned by the user's own
 *  Google account, so they count against THEIR Drive storage — not a
 *  service account's separate (and much smaller) quota. */
export async function getAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      refresh_token: requireEnv('GOOGLE_OAUTH_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google 토큰 갱신 실패: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.access_token;
}

function escapeQ(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Finds a folder by name under a parent, creating it if it doesn't
 *  exist yet. Safe to call repeatedly — never creates a duplicate. */
export async function ensureFolder({ name, parentId, token }) {
  const q = `name='${escapeQ(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await fetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) throw new Error(`Drive 폴더 조회 실패: ${(await listRes.text()).slice(0, 300)}`);
  const found = await listRes.json();
  if (found.files?.[0]?.id) return found.files[0].id;

  const createRes = await fetch(FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!createRes.ok) throw new Error(`Drive 폴더 생성 실패: ${(await createRes.text()).slice(0, 300)}`);
  const created = await createRes.json();
  return created.id;
}

/** True if a file with this exact name already exists directly under
 *  the folder — lets a backup run skip files it already copied over. */
export async function fileExistsInFolder({ name, folderId, token }) {
  return Boolean(await findFileInFolder({ name, folderId, token }));
}

/** Returns the first non-trashed file with an exact name in a folder. */
export async function findFileInFolder({ name, folderId, token }) {
  const q = `name='${escapeQ(name)}' and '${folderId}' in parents and trashed=false`;
  const res = await fetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&spaces=drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive 파일 조회 실패: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

/** Multipart upload — metadata + raw bytes in one request. */
export async function uploadFile({ name, mimeType, buffer, folderId, token }) {
  const boundary = `nayul-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf-8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
  const body = Buffer.concat([head, buffer, tail]);

  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive 업로드 실패: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Replaces an existing Drive file's bytes without changing its file ID. */
export async function updateFile({ fileId, mimeType, buffer, token }) {
  const res = await fetch(`${UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,size,modifiedTime`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Drive 파일 갱신 실패: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Drive is the durable source of truth. Repeated writes update the same
 *  object so a photo edit cannot leave a stale same-named backup behind. */
export async function upsertFile({ name, mimeType, buffer, folderId, token }) {
  const existing = await findFileInFolder({ name, folderId, token });
  if (existing?.id) {
    const updated = await updateFile({ fileId: existing.id, mimeType, buffer, token });
    return { ...existing, ...updated, created: false };
  }
  const created = await uploadFile({ name, mimeType, buffer, folderId, token });
  return { ...created, created: true };
}

/** Downloads the raw bytes for a regular Drive file. */
export async function downloadFile({ fileId, token }) {
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const error = new Error(`Drive 파일 다운로드 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: res.headers.get('content-type') || 'application/octet-stream',
  };
}
