import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Free Dictionary API (dictionaryapi.dev) — no key, no cost. Gives a short
// definition plus a native-recorded pronunciation clip for single English
// words. Multi-word phrases (also allowed in keyVocab) just 404 here, which
// we treat as "no dictionary entry" and skip quietly.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const word = (searchParams.get('word') || '').trim().toLowerCase();
  if (!word) return NextResponse.json({ found: false });

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) return NextResponse.json({ found: false });
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return NextResponse.json({ found: false });

    const audio = (entry.phonetics || []).map((p) => p.audio).find((a) => a) || '';
    const phonetic = entry.phonetic || (entry.phonetics || []).map((p) => p.text).find((t) => t) || '';
    const firstMeaning = (entry.meanings || [])[0];
    const definition = firstMeaning?.definitions?.[0]?.definition || '';
    const partOfSpeech = firstMeaning?.partOfSpeech || '';

    return NextResponse.json({ found: true, word: entry.word || word, phonetic, audio, partOfSpeech, definition });
  } catch (e) {
    console.error('vocab lookup failed', word, e);
    return NextResponse.json({ found: false });
  }
}
