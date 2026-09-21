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
  if (!bookId || !spreadNumber) return null;
  // Fast path: Supabase's public CDN URL directly — no serverless hop for
  // the common case of a photo that's already cached there.
  return publicStorageUrl('book-photos', `${bookId}/${spreadNumber}.jpg`);
}

/** Fallback for spreadPhotoUrl — routes through our server, which also
 *  tries the Google Drive backup and quietly restores Supabase's copy.
 *  Wire this to an <img onError> so it only kicks in on an actual miss. */
export function spreadPhotoFallbackUrl(bookId, spreadNumber) {
  if (!bookId || !spreadNumber) return null;
  return mediaUrl('book-photos', `${bookId}/${spreadNumber}.jpg`, bookId);
}

function mediaUrl(bucket, path, bookId) {
  const params = new URLSearchParams({ bucket, path, bookId });
  return `/api/media?${params.toString()}`;
}

function publicStorageUrl(bucket, path) {
  if (!supabaseReady) return null;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

/** Saves to Google Drive first (durable original), then lets the server
 *  mirror the same bytes into Supabase Storage as a replaceable cache. */
export async function storeMediaBlob({ bucket, path, bookId, blob }) {
  const form = new FormData();
  form.append('bucket', bucket);
  form.append('path', path);
  form.append('bookId', bookId);
  form.append('file', blob, path.split('/').pop());
  const res = await fetch('/api/media/store', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
      a.removeEventListener('pause', onPause);
      if (currentAudio === a) currentAudio = null;
    };
    const onEnded = () => { cleanup(); resolve(true); };
    const onError = () => { cleanup(); resolve(false); };
    // stopSpeaking() calls .pause() to interrupt (e.g. the pause button
    // mid-reply) — that fires a native 'pause' event but NOT 'ended' or
    // 'error', so without this the promise here would hang forever and
    // `speaking` would get stuck true. BUT some browsers also fire 'pause'
    // when playback reaches its natural end (alongside 'ended'), and
    // whichever fires first wins the resolve() — if it were treated as a
    // failure every time, a fully-successful read-aloud would get replayed
    // from cache, then replayed AGAIN freshly generated. `a.ended` is set
    // by the spec before any end-of-media event fires, so checking it here
    // tells a real interruption (ended still false) apart from a natural
    // finish that happened to fire 'pause' too (ended already true).
    const onPause = () => { cleanup(); resolve(a.ended); };
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    a.addEventListener('pause', onPause);
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

async function generateAndPlay(line, slow, cachePath, voice, bookId) {
  const blob = await generateAudioBlob(line, slow, voice);
  if (cancelled) return;

  if (cachePath && bookId) {
    // Drive is the source of truth, so finish the durable write before
    // treating a newly generated clip as cached.
    try {
      await storeMediaBlob({ bucket: 'tts-cache', path: cachePath, bookId, blob });
    } catch (e) {
      console.error('durable TTS save failed', e);
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const played = await playFromUrl(objectUrl);
  URL.revokeObjectURL(objectUrl);
  if (!played) console.warn('freshly generated audio failed to play', line.text.slice(0, 30));
}

async function playOne(line, slow, cacheable, voice, bookId) {
  if (!line.text || !line.text.trim()) return;
  const resolvedVoice = line.voice || voice; // a character's fixed voice overrides the narrator/default one

  if (cacheable && bookId) {
    try {
      const path = await cacheKeyFor(line, slow, resolvedVoice);

      // Fast path: hit Supabase's public CDN URL directly — no serverless
      // hop, no existence check first. This is the common case for a book
      // that's already been read before, so a re-read should never feel
      // like it's "checking" anything; it should just play.
      const directUrl = publicStorageUrl('tts-cache', path);
      if (directUrl) {
        const played = await playFromUrl(directUrl);
        if (played) return;
      }

      // Missed the fast cache — fall back through our server, which also
      // tries the Google Drive backup and quietly restores Supabase's
      // copy so the NEXT read hits the fast path again.
      const proxyUrl = mediaUrl('tts-cache', path, bookId);
      const restored = await playFromUrl(proxyUrl);
      if (restored) return;

      await generateAndPlay(line, slow, path, resolvedVoice, bookId);
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
export async function speakLines(lines, { slow = false, muted = false, cacheable = false, voice = '', bookId = '' } = {}) {
  if (muted) return;
  cancelled = false;
  for (const line of lines) {
    if (cancelled) return;
    try {
      await playOne(line, slow, cacheable, voice, bookId);
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

/** Checks how many read-aloud lines are available. A missing Supabase
 *  cache object is restored from Drive during this check. */
export async function checkCacheStatus(spreads, { voice = '', characterVoices = {}, slow = false, bookId = '' } = {}) {
  if (!bookId) return { cached: 0, total: 0 };
  const lines = (spreads || [])
    .flatMap((s) => spreadLines(s, characterVoices))
    .filter((l) => l.text && l.text.trim());
  let cached = 0;
  for (const line of lines) {
    const resolvedVoice = line.voice || voice;
    try {
      const path = await cacheKeyFor(line, slow, resolvedVoice);
      if (await existsAt(mediaUrl('tts-cache', path, bookId))) cached++;
    } catch {
      // treat as not-cached
    }
  }
  return { cached, total: lines.length };
}

/** Migrates legacy Supabase-only objects into the Drive-first store.
 *  New files are already saved to Drive automatically. Re-running this
 *  function refreshes existing Drive originals and their metadata. */
export async function backupBookToDrive(book, { voice = '', characterVoices = {}, slow = false, onProgress } = {}) {
  const initRes = await fetch('/api/backup-drive/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, bookTitle: book.title }),
  });
  if (!initRes.ok) throw new Error(await initRes.text());
  await initRes.json();

  const items = [];
  for (const s of book.spreads || []) {
    const path = `${book.id}/${s.number}.jpg`;
    const url = publicStorageUrl('book-photos', path);
    if (url && (await existsAt(mediaUrl('book-photos', path, book.id)))) {
      items.push({ bucket: 'book-photos', path, filename: `${s.number}.jpg`, sourceUrl: url, mimeType: 'image/jpeg', label: `사진 ${s.number}` });
    }
  }
  for (const line of (book.spreads || []).flatMap((s) => spreadLines(s, characterVoices))) {
    if (!line.text || !line.text.trim()) continue;
    const resolvedVoice = line.voice || voice;
    const path = await cacheKeyFor(line, slow, resolvedVoice);
    const sourceUrl = publicStorageUrl('tts-cache', path);
    if (sourceUrl && (await existsAt(mediaUrl('tts-cache', path, book.id)))) {
      items.push({ bucket: 'tts-cache', path, filename: path, sourceUrl, mimeType: 'audio/mpeg', label: '음성' });
    }
  }

  let uploaded = 0, updated = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    onProgress?.(i, items.length, it.label);
    try {
      const res = await fetch('/api/backup-drive/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: book.id, bucket: it.bucket, path: it.path, filename: it.filename, sourceUrl: it.sourceUrl, mimeType: it.mimeType }),
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      if (r.created) uploaded++; else updated++;
    } catch (e) {
      console.error('drive backup failed for', it.filename, e);
      failed++;
    }
  }
  onProgress?.(items.length, items.length, '');
  return { uploaded, updated, failed, total: items.length };
}

/** Synthesizes and caches every read-aloud line in a book UP FRONT —
 *  page text (per character voice where applicable), asides, sound effects
 *  — without playing any of it, so the actual reading session is instant
 *  playback with no per-page generate-and-wait. Skips lines already cached
 *  (safe to re-run after editing text; only changed lines regenerate).
 *  Calls onProgress(done, total) as it goes. No-ops if Supabase storage
 *  isn't configured. */
export async function precacheSpreads(spreads, { voice = '', characterVoices = {}, slow = false, bookId = '', onProgress } = {}) {
  if (!bookId) return;
  const lines = (spreads || []).flatMap((s) => spreadLines(s, characterVoices));
  const total = lines.length;
  let done = 0;
  for (const line of lines) {
    if (line.text && line.text.trim()) {
      const resolvedVoice = line.voice || voice;
      try {
        const path = await cacheKeyFor(line, slow, resolvedVoice);
        const already = await existsAt(mediaUrl('tts-cache', path, bookId));
        if (!already) {
          const blob = await generateAudioBlob(line, slow, resolvedVoice);
          await storeMediaBlob({ bucket: 'tts-cache', path, bookId, blob });
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
 * as a plain 16-bit PCM WAV ourselves. No library needed. We also resample
 * down to 16kHz mono — plenty for speech, and it keeps even a fairly long
 * turn well clear of Vercel's ~4.5MB request-body limit (native 44.1kHz
 * WAV blows past that around 30-40 seconds; 16kHz stretches that to
 * roughly two minutes). */

function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

async function resampleTo16kMono(audioBuffer) {
  const targetRate = 16000;
  if (audioBuffer.sampleRate === targetRate && audioBuffer.numberOfChannels === 1) return audioBuffer;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const length = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
  const offlineCtx = new OfflineCtx(1, length, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();
  return offlineCtx.startRendering();
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
async function encodeDecodedToBase64(decoded) {
  const resampled = await resampleTo16kMono(decoded);
  const wavBlob = encodeWav(resampled);
  return arrayBufferToBase64(await wavBlob.arrayBuffer());
}

async function decodeRecordedBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }
}

export async function stopRecordingAsWav() {
  const blob = await stopRecordingRaw();
  if (!blob) return null;
  const decoded = await decodeRecordedBlob(blob);
  return encodeDecodedToBase64(decoded);
}

/* ---------- hands-free listening (auto start / auto stop) ----------
 * Instead of requiring a tap to start AND a tap to stop, this records and
 * watches the mic's volume in real time: once it's heard some speech and
 * then gone quiet for a bit, it stops on its own. A hard max duration
 * guards against an open mic that never gets a real answer (or endless
 * background noise) running forever. */

// A Web Audio AudioContext starts "suspended" unless it's created (and
// resumed) within a real user gesture's call stack — iOS Safari enforces
// this strictly. Auto-listen cycles after the first aren't gesture-
// triggered, so a fresh context per cycle can stay silently suspended on
// iPhone, making the analyser read 0 forever (it would never notice she's
// talking). Reusing ONE context and resuming it — ideally first primed
// from an actual tap via primeAudio() — avoids that.
let sharedVadCtx = null;

async function getVadCtx() {
  if (typeof window === 'undefined') return null;
  if (!sharedVadCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedVadCtx = new AudioCtx();
  }
  if (sharedVadCtx.state === 'suspended') {
    try { await sharedVadCtx.resume(); } catch (e) { console.error('vad context resume failed', e); }
  }
  return sharedVadCtx;
}

/** Call from a direct tap handler (e.g. "이야기 시작하기") before the first
 *  auto-listen cycle of a chat screen — gives iOS its best chance to let
 *  the shared listening context (and the mic permission prompt, the first
 *  time) actually latch on inside a real gesture. Safe to call repeatedly;
 *  also fine to skip, generateAndPlay/listenUntilSilence will still lazily
 *  create and try to resume the context on their own either way. */
export async function primeAudio() {
  try { await getVadCtx(); } catch (e) { console.error('primeAudio failed', e); }
}

let forceStop = false;
let listenCancelled = false;

/** Ends the current listen-and-wait early, AS IF she'd just gone quiet —
 *  used when a parent taps the mic while it's already auto-listening,
 *  meaning "she's done, send it now." */
export function forceStopListening() {
  forceStop = true;
}

/** Ends the current listen-and-wait early and DISCARDS it — used when
 *  switching to the Korean fallback mic mid-listen. */
export function cancelListening() {
  listenCancelled = true;
  forceStop = true;
}

/* ---------- rough child-voice filter (pitch-based, not identity) ----------
 * This can only tell "does this sound like a young child" from pitch
 * (fundamental frequency) — it cannot recognize ONE specific person. A
 * young child's voice runs roughly 250-400Hz; adult male is usually
 * 85-180Hz, so a low threshold reliably screens out an adult (especially
 * male) voice answering instead, without much risk of rejecting her own
 * real answers. Adult female voices can still overlap and pass through —
 * true speaker identification would need a dedicated service. */
const MIN_CHILD_HZ = 170;

function autocorrelatePitch(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null; // too quiet to be voiced speech

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) < thres) { r1 = i; break; } }
  for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; } }
  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  if (n < 8) return null;

  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    c[lag] = sum;
  }
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) { if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; } }
  if (maxPos <= 0) return null;
  let T0 = maxPos;
  if (T0 > 0 && T0 < n - 1) {
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);
  }
  return T0 > 0 ? sampleRate / T0 : null;
}

/** Median fundamental-frequency estimate across the recording, in Hz, or
 *  null if no clearly-voiced frame was found at all. */
function estimatePitchHz(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const data = audioBuffer.getChannelData(0);
  const windowSize = 2048;
  const hop = Math.max(1, Math.floor(sampleRate * 0.1)); // ~every 100ms
  const pitches = [];
  for (let start = 0; start + windowSize <= data.length; start += hop) {
    const p = autocorrelatePitch(data.subarray(start, start + windowSize), sampleRate);
    if (p != null && p > 60 && p < 800) pitches.push(p); // plausible human-voice range
  }
  if (!pitches.length) return null;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)];
}

export async function listenUntilSilence({
  // A young child often pauses mid-sentence while forming words — 1.8s
  // of quiet was cutting some of those off before she'd finished, which
  // is part of why recognition felt worse than a live chat: the model
  // was hearing an incomplete sentence, not a bad one.
  silenceMs = 2400,
  minSpeechMs = 400,
  maxMs = 25000,
  requireChildVoice = true,
  onLevel,
} = {}) {
  forceStop = false;
  listenCancelled = false;
  await startRecording();
  const stream = recorder?.stream;
  if (!stream) return { audio: null, rejected: false };

  const vadCtx = await getVadCtx();
  if (!vadCtx) return { audio: null, rejected: false };
  const source = vadCtx.createMediaStreamSource(stream);
  const analyser = vadCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const startedAt = Date.now();
  let lastLoud = startedAt;
  let heardSpeech = false;
  const THRESHOLD = 14; // rough average byte-frequency level for a quiet home mic; may need tuning

  await new Promise((resolve) => {
    function tick() {
      if (forceStop) return resolve();
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      onLevel?.(Math.min(1, avg / 60));
      const now = Date.now();
      if (avg > THRESHOLD) {
        lastLoud = now;
        if (now - startedAt > minSpeechMs) heardSpeech = true;
      }
      if (now - startedAt > maxMs) return resolve();
      if (heardSpeech && now - lastLoud > silenceMs) return resolve();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  try { source.disconnect(); } catch {}
  // Don't close the context — it's shared/reused across listen cycles so
  // it stays in the "running" state a fresh one wouldn't reliably reach
  // on iOS Safari (see getVadCtx for why).
  onLevel?.(0);

  if (listenCancelled) {
    await stopRecordingRaw(); // stop and discard
    return { audio: null, rejected: false };
  }
  if (!heardSpeech) {
    await stopRecordingRaw(); // nothing said (silence timed out) — not worth sending
    return { audio: null, rejected: false };
  }

  const blob = await stopRecordingRaw();
  if (!blob) return { audio: null, rejected: false };
  const decoded = await decodeRecordedBlob(blob);

  if (requireChildVoice) {
    const pitch = estimatePitchHz(decoded);
    if (pitch != null && pitch < MIN_CHILD_HZ) {
      return { audio: null, rejected: true, pitchHz: pitch };
    }
  }

  const audio = await encodeDecodedToBase64(decoded);
  return { audio, rejected: false };
}
