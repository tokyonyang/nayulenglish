'use client';

import { supabase, supabaseReady } from '@/lib/supabase';

let currentAudio = null;
let cancelled = false;

// Reused across every clip in a book instead of `new Audio()` per line.
// iOS Safari's autoplay policy only reliably allows programmatic .play()
// calls that continue a media session already granted by a user gesture —
// a fresh Audio() element for each auto-advanced page can get silently
// blocked, which used to look exactly like "does nothing, moves on".
// Reusing one element keeps it inside that granted session.
let sharedAudioEl = null;
function getAudioEl() {
  if (typeof window === 'undefined') return null;
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio();
    sharedAudioEl.preload = 'auto';
  }
  return sharedAudioEl;
}

export function stopSpeaking() {
  cancelled = true;
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {}
    currentAudio = null;
  }
}

/* ---------- TTS cache (Stage 1 read-aloud only) ----------
 * A book's spreads are read aloud fresh every day for its whole 7-day
 * cycle, but the text never changes — so we hash (text+tone+slow) and
 * store the mp3 in Supabase Storage. Same line next time = free replay,
 * no OpenAI call. Conversational (Stage 2/3) lines are never repeated,
 * so callers leave `cacheable` off for those — caching would only add
 * a network round trip with no benefit. */

export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable',
  'juniper', 'marin', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
];

export function spreadPhotoUrl(bookId, spreadNumber) {
  if (!supabaseReady || !bookId || !spreadNumber) return null;
  const { data } = supabase.storage.from('book-photos').getPublicUrl(`${bookId}/${spreadNumber}.jpg`);
  return data?.publicUrl || null;
}

export async function cacheKeyFor(line, slow, voice) {
  const raw = `${line.text}|${line.tone || ''}|${line.direction || ''}|${slow ? 1 : 0}|${voice || ''}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40) + '.mp3';
}

async function existsAt(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Plays a URL on the shared, reused audio element. Resolves `true` once
 *  playback actually finished, `false` if it failed to play at all (404,
 *  decode error, or blocked) — callers use this to fall back instead of
 *  silently treating a blocked/broken clip as "done". */
async function playFromUrl(url) {
  const a = getAudioEl();
  if (!a) return false;
  currentAudio = a;
  return new Promise((resolve) => {
    const cleanup = () => {
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
      if (currentAudio === a) currentAudio = null;
    };
    const onEnded = () => { cleanup(); resolve(true); };
    const onError = () => { cleanup(); resolve(false); };
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    try {
      a.src = url;
      a.load(); // WebKit needs this after swapping src on a reused element to reliably pick it up
      const p = a.play();
      if (p?.catch) p.catch(() => { cleanup(); resolve(false); });
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

async function generateAudioBlob(line, slow, voice) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: line.text, tone: line.tone, direction: line.direction, slow, voice }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.blob();
}

async function generateAndPlay(line, slow, cachePath, voice) {
  const blob = await generateAudioBlob(line, slow, voice);
  if (cancelled) return;

  if (cachePath && supabaseReady) {
    // Don't block playback on the upload — save it for next time in the background.
    supabase.storage
      .from('tts-cache')
      .upload(cachePath, blob, { contentType: 'audio/mpeg', upsert: true })
      .catch((e) => console.error('tts cache upload failed', e));
  }

  const objectUrl = URL.createObjectURL(blob);
  const played = await playFromUrl(objectUrl);
  URL.revokeObjectURL(objectUrl);
  if (!played) console.warn('freshly generated audio failed to play', line.text.slice(0, 30));
}

async function playOne(line, slow, cacheable, voice) {
  if (!line.text || !line.text.trim()) return;
  const resolvedVoice = line.voice || voice; // a character's fixed voice overrides the narrator/default one

  if (cacheable && supabaseReady) {
    try {
      const path = await cacheKeyFor(line, slow, resolvedVoice);
      const { data } = supabase.storage.from('tts-cache').getPublicUrl(path);
      if (data?.publicUrl && (await existsAt(data.publicUrl))) {
        const played = await playFromUrl(data.publicUrl);
        if (played) return;
        console.warn('cached audio found but failed to play — regenerating', line.text.slice(0, 30));
      }
      await generateAndPlay(line, slow, path, resolvedVoice);
      return;
    } catch (e) {
      console.error('cached TTS failed, falling back', e);
    }
  }
  await generateAndPlay(line, slow, null, resolvedVoice);
}

/** lines: [{text, tone, direction?}] — played in order, stoppable with
 *  stopSpeaking(). Pass `cacheable: true` for content that repeats verbatim
 *  across sessions (book read-aloud text) so it's synthesized once and
 *  reused. `voice` is any OpenAI TTS voice name (see TTS_VOICES); omit for
 *  the API default. */
export async function speakLines(lines, { slow = false, muted = false, cacheable = false, voice = '' } = {}) {
  if (muted) return;
  cancelled = false;
  for (const line of lines) {
    if (cancelled) return;
    try {
      await playOne(line, slow, cacheable, voice);
    } catch (e) {
      console.error('TTS failed', e);
      return;
    }
  }
}

function normalizeForSpeech(text) {
  return String(text || '').replace(/\n+/g, ' ').trim();
}

/** Read one spread the way a parent would: narration and each character's
 *  dialogue as their own continuous, naturally-flowing lines (not chopped
 *  per-sentence — that kills prosody), then a sound effect if the page has one.
 *  If the page has speaker-tagged dialogue, each named character's segment
 *  is voiced with THEIR fixed voice from `characterVoices` (falling back to
 *  the narrator/default voice if that character has none assigned yet);
 *  narration always uses the narrator voice. voiceDirection — a scene-
 *  specific delivery note — applies to every segment on the page. */
export function spreadLines(spread, characterVoices = {}) {
  const lines = [];
  const segments = Array.isArray(spread.dialogue) && spread.dialogue.length
    ? spread.dialogue
    : [{ speaker: 'Narrator', text: spread.englishText }];

  for (const seg of segments) {
    const text = normalizeForSpeech(seg?.text);
    if (!text) continue;
    const isCharacter = seg?.speaker && seg.speaker !== 'Narrator';
    const voice = isCharacter ? characterVoices[seg.speaker] : undefined; // undefined = use the narrator/default voice
    lines.push({ text, tone: spread.tone || 'calm', direction: spread.voiceDirection || '', voice });
  }
  // Note: we deliberately don't read the picture's scene interpretation
  // aloud in English page-by-page (a parent-facing request) — only the
  // book's own printed/typed text, character dialogue, and sound effects.
  (spread.sfx || []).forEach((s) => lines.push({ text: s, tone: 'sfx' }));
  return lines;
}

/** One continuous line per turn, same reason — a conversational reply
 *  read as a single natural utterance instead of fragmented sentences. */
export function chatLines(text) {
  const t = normalizeForSpeech(text);
  return t ? [{ text: t, tone: 'chat' }] : [];
}

/** Checks how many of a book's read-aloud lines already have a cached
 *  clip in Supabase Storage — WITHOUT generating anything — so a parent
 *  can verify the cache is actually accumulating rather than just taking
 *  it on faith. Returns {cached, total}. */
export async function checkCacheStatus(spreads, { voice = '', characterVoices = {}, slow = false } = {}) {
  if (!supabaseReady) return { cached: 0, total: 0 };
  const lines = (spreads || [])
    .flatMap((s) => spreadLines(s, characterVoices))
    .filter((l) => l.text && l.text.trim());
  let cached = 0;
  for (const line of lines) {
    const resolvedVoice = line.voice || voice;
    try {
      const path = await cacheKeyFor(line, slow, resolvedVoice);
      const { data } = supabase.storage.from('tts-cache').getPublicUrl(path);
      if (data?.publicUrl && (await existsAt(data.publicUrl))) cached++;
    } catch {
      // treat as not-cached
    }
  }
  return { cached, total: lines.length };
}

/** On-demand backup: copies whatever's already in Supabase Storage for
 *  this book — page photos and any cached read-aloud audio — into the
 *  user's own Google Drive (via /api/backup-drive), where it draws on
 *  their own account's storage rather than Supabase's much smaller free
 *  tier. This is deliberately NOT automatic: it only runs when this
 *  function is called (a button press), and each file is skipped
 *  server-side if a same-named file already exists in the target Drive
 *  folder — so re-running after adding a page or a new cached line only
 *  uploads what's actually new. Calls onProgress(done, total, label) as
 *  it goes. Returns {uploaded, skipped, failed, total}. */
export async function backupBookToDrive(book, { voice = '', characterVoices = {}, slow = false, onProgress } = {}) {
  const initRes = await fetch('/api/backup-drive/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, bookTitle: book.title }),
  });
  if (!initRes.ok) throw new Error(await initRes.text());
  const { photosFolderId, audioFolderId } = await initRes.json();

  const items = [];
  for (const s of book.spreads || []) {
    const url = spreadPhotoUrl(book.id, s.number);
    if (url) items.push({ folderId: photosFolderId, filename: `${s.number}.jpg`, sourceUrl: url, mimeType: 'image/jpeg', label: `사진 ${s.number}` });
  }
  for (const line of (book.spreads || []).flatMap((s) => spreadLines(s, characterVoices))) {
    if (!line.text || !line.text.trim()) continue;
    const resolvedVoice = line.voice || voice;
    const path = await cacheKeyFor(line, slow, resolvedVoice);
    const { data } = supabase.storage.from('tts-cache').getPublicUrl(path);
    if (data?.publicUrl && (await existsAt(data.publicUrl))) {
      items.push({ folderId: audioFolderId, filename: path, sourceUrl: data.publicUrl, mimeType: 'audio/mpeg', label: '음성' });
    }
  }

  let uploaded = 0, skipped = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    onProgress?.(i, items.length, it.label);
    try {
      const res = await fetch('/api/backup-drive/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: it.folderId, filename: it.filename, sourceUrl: it.sourceUrl, mimeType: it.mimeType }),
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      if (r.skipped) skipped++; else uploaded++;
    } catch (e) {
      console.error('drive backup failed for', it.filename, e);
      failed++;
    }
  }
  onProgress?.(items.length, items.length, '');
  return { uploaded, skipped, failed, total: items.length };
}

/** Synthesizes and caches every read-aloud line in a book UP FRONT —
 *  page text (per character voice where applicable), asides, sound effects
 *  — without playing any of it, so the actual reading session is instant
 *  playback with no per-page generate-and-wait. Skips lines already cached
 *  (safe to re-run after editing text; only changed lines regenerate).
 *  Calls onProgress(done, total) as it goes. No-ops if Supabase storage
 *  isn't configured. */
export async function precacheSpreads(spreads, { voice = '', characterVoices = {}, slow = false, onProgress } = {}) {
  if (!supabaseReady) return;
  const lines = (spreads || []).flatMap((s) => spreadLines(s, characterVoices));
  const total = lines.length;
  let done = 0;
  for (const line of lines) {
    if (line.text && line.text.trim()) {
      const resolvedVoice = line.voice || voice;
      try {
        const path = await cacheKeyFor(line, slow, resolvedVoice);
        const { data } = supabase.storage.from('tts-cache').getPublicUrl(path);
        const already = data?.publicUrl && (await existsAt(data.publicUrl));
        if (!already) {
          const blob = await generateAudioBlob(line, slow, resolvedVoice);
          await supabase.storage.from('tts-cache').upload(path, blob, { contentType: 'audio/mpeg', upsert: true });
        }
      } catch (e) {
        console.error('precache failed for line', line.text.slice(0, 30), e);
      }
    }
    done++;
    onProgress?.(done, total);
  }
}

/* ---------- microphone ---------- */

let recorder = null;
let chunks = [];

export function recordingSupported() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();
}

async function stopRecordingRaw() {
  if (!recorder) return null;
  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    recorder.stop();
  });
  recorder.stream.getTracks().forEach((t) => t.stop());
  recorder = null;
  return blob;
}

export async function stopRecordingAndTranscribe(language = 'en') {
  const blob = await stopRecordingRaw();
  if (!blob) return '';
  const form = new FormData();
  form.append('audio', blob, 'speech.webm');
  form.append('language', language);
  const res = await fetch('/api/stt', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.text || '';
}

/* ---------- raw audio for the conversation model to hear directly ----------
 * OpenAI's audio-input models only take wav or mp3, but MediaRecorder gives
 * us webm (or mp4 on Safari) — so we decode via Web Audio API and re-encode
 * as a plain 16-bit PCM WAV ourselves. No library needed. */

function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWav(audioBuffer) {
  const ch0 = audioBuffer.getChannelData(0);
  const samples = audioBuffer.numberOfChannels > 1
    ? Float32Array.from(ch0, (v, i) => (v + audioBuffer.getChannelData(1)[i]) / 2) // downmix to mono
    : ch0;
  const sampleRate = audioBuffer.sampleRate;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  floatTo16BitPCM(view, 44, samples);
  return new Blob([view], { type: 'audio/wav' });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Stops the current recording and returns it as a base64 WAV string,
 *  ready to send straight to an audio-input chat model — no transcription
 *  step first, so the model hears pronunciation, tone and hesitation
 *  instead of just flat text. Returns null if nothing was recording. */
export async function stopRecordingAsWav() {
  const blob = await stopRecordingRaw();
  if (!blob) return null;
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const wavBlob = encodeWav(audioBuffer);
    return arrayBufferToBase64(await wavBlob.arrayBuffer());
  } finally {
    ctx.close();
  }
}
