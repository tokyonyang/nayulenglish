'use client';

import { supabase, supabaseReady } from '@/lib/supabase';

let currentAudio = null;
let cancelled = false;

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

async function cacheKeyFor(text, tone, slow, voice) {
  const raw = `${text}|${tone || ''}|${slow ? 1 : 0}|${voice || ''}`;
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

async function playFromUrl(url) {
  await new Promise((resolve) => {
    const a = new Audio(url);
    currentAudio = a;
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
  currentAudio = null;
}

async function generateAndPlay(text, tone, slow, cachePath, voice) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, tone, slow, voice }),
  });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  if (cancelled) return;

  if (cachePath && supabaseReady) {
    // Don't block playback on the upload — save it for next time in the background.
    supabase.storage
      .from('tts-cache')
      .upload(cachePath, blob, { contentType: 'audio/mpeg', upsert: true })
      .catch((e) => console.error('tts cache upload failed', e));
  }

  const objectUrl = URL.createObjectURL(blob);
  await playFromUrl(objectUrl);
  URL.revokeObjectURL(objectUrl);
}

async function playOne(text, tone, slow, cacheable, voice) {
  if (!text || !text.trim()) return;

  if (cacheable && supabaseReady) {
    try {
      const path = await cacheKeyFor(text, tone, slow, voice);
      const { data } = supabase.storage.from('tts-cache').getPublicUrl(path);
      if (data?.publicUrl && (await existsAt(data.publicUrl))) {
        await playFromUrl(data.publicUrl);
        return;
      }
      await generateAndPlay(text, tone, slow, path, voice);
      return;
    } catch (e) {
      console.error('cached TTS failed, falling back', e);
    }
  }
  await generateAndPlay(text, tone, slow, null, voice);
}

/** lines: [{text, tone}] — played in order, stoppable with stopSpeaking().
 *  Pass `cacheable: true` for content that repeats verbatim across sessions
 *  (book read-aloud text) so it's synthesized once and reused. `voice` is
 *  any OpenAI TTS voice name (see TTS_VOICES); omit for the API default. */
export async function speakLines(lines, { slow = false, muted = false, cacheable = false, voice = '' } = {}) {
  if (muted) return;
  cancelled = false;
  for (const line of lines) {
    if (cancelled) return;
    try {
      await playOne(line.text, line.tone, slow, cacheable, voice);
    } catch (e) {
      console.error('TTS failed', e);
      return;
    }
  }
}

function normalizeForSpeech(text) {
  return String(text || '').replace(/\n+/g, ' ').trim();
}

/** Read one spread the way a parent would: the page's text as one
 *  continuous, naturally-flowing read (not chopped into separate
 *  per-sentence audio clips — that kills cross-sentence prosody and
 *  sounds stilted), then any aside, then a sound effect as their own
 *  short beats. */
export function spreadLines(spread) {
  const lines = [];
  const text = normalizeForSpeech(spread.englishText);
  if (text) lines.push({ text, tone: spread.tone || 'calm' });
  (spread.asides || []).forEach((a) => lines.push({ text: a, tone: 'calm' }));
  (spread.sfx || []).forEach((s) => lines.push({ text: s, tone: 'sfx' }));
  return lines;
}

/** One continuous line per turn, same reason — a conversational reply
 *  read as a single natural utterance instead of fragmented sentences. */
export function chatLines(text) {
  const t = normalizeForSpeech(text);
  return t ? [{ text: t, tone: 'chat' }] : [];
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

export async function stopRecordingAndTranscribe(language = 'en') {
  if (!recorder) return '';
  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    recorder.stop();
  });
  recorder.stream.getTracks().forEach((t) => t.stop());
  recorder = null;

  const form = new FormData();
  form.append('audio', blob, 'speech.webm');
  form.append('language', language);
  const res = await fetch('/api/stt', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.text || '';
}
