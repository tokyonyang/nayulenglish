'use client';

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

async function playOne(text, tone, slow) {
  if (!text || !text.trim()) return;
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, tone, slow }),
  });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  if (cancelled) return;
  const url = URL.createObjectURL(blob);
  await new Promise((resolve) => {
    const a = new Audio(url);
    currentAudio = a;
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
  currentAudio = null;
  URL.revokeObjectURL(url);
}

/** lines: [{text, tone}] — played in order, stoppable with stopSpeaking(). */
export async function speakLines(lines, { slow = false, muted = false } = {}) {
  if (muted) return;
  cancelled = false;
  for (const line of lines) {
    if (cancelled) return;
    try {
      await playOne(line.text, line.tone, slow);
    } catch (e) {
      console.error('TTS failed', e);
      return;
    }
  }
}

export function splitSentences(text) {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read one spread the way a parent would: the text, then asides, then a sound effect. */
export function spreadLines(spread) {
  const lines = splitSentences(spread.englishText).map((t) => ({ text: t, tone: spread.tone || 'calm' }));
  (spread.asides || []).forEach((a) => lines.push({ text: a, tone: 'calm' }));
  (spread.sfx || []).forEach((s) => lines.push({ text: s, tone: 'sfx' }));
  return lines;
}

export function chatLines(text) {
  return splitSentences(text).map((t) => ({ text: t, tone: 'chat' }));
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
