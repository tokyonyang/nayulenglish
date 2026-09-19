import { TTS_VOICES } from '@/lib/audio';

export function blankSpread(number, englishText = '') {
  return {
    number,
    englishText,
    sceneDescription: '',
    textUncertain: false,
    error: null,
    tone: 'calm',
    voiceDirection: '',
    dialogue: [],
    asides: [],
    sfx: [],
    keyVocab: [],
    speakingValue: 3,
  };
}

export async function enrichSpreads(spreads) {
  const res = await fetch('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spreads }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function isValidDialogue(dialogue, fallbackText) {
  if (!Array.isArray(dialogue) || !dialogue.length) return false;
  const joined = dialogue.map((d) => String(d?.text || '')).join('');
  // Loose sanity check — the model is asked to reproduce the text verbatim,
  // so a wildly different length means it drifted; fall back to Narrator-only.
  const a = joined.replace(/\s+/g, '');
  const b = String(fallbackText || '').replace(/\s+/g, '');
  return b.length === 0 || Math.abs(a.length - b.length) <= Math.max(10, b.length * 0.2);
}

export function mergeEnrichment(spreads, enr) {
  const list = Array.isArray(enr?.spreads) ? enr.spreads : [];
  return spreads.map((s) => {
    const e = list.find((x) => Number(x.number) === s.number) || {};
    const dialogue = isValidDialogue(e.dialogue, s.englishText)
      ? e.dialogue.map((d) => ({ speaker: String(d?.speaker || 'Narrator'), text: String(d?.text || '') }))
      : s.dialogue;
    return {
      ...s,
      sceneDescription: s.sceneDescription || String(e.scene || ''),
      tone: e.tone || s.tone || 'calm',
      voiceDirection: String(e.voiceDirection || '') || s.voiceDirection || '',
      dialogue,
      asides: Array.isArray(e.asides) ? e.asides.slice(0, 2) : s.asides,
      sfx: Array.isArray(e.sfx) ? e.sfx.slice(0, 1) : s.sfx,
      keyVocab: Array.isArray(e.keyVocab) ? e.keyVocab.slice(0, 3) : s.keyVocab,
      speakingValue: Number(e.speakingValue) || s.speakingValue || 3,
    };
  });
}

/** Assigns each newly-seen character a TTS voice, distinct from voices
 *  already in use, and NEVER reassigns a character who already has one —
 *  once fixed, a character's voice stays the same for the life of the book. */
export function assignCharacterVoices(existing, characters) {
  const map = { ...(existing || {}) };
  const used = new Set(Object.values(map));
  let cursor = 0;
  for (const name of characters || []) {
    if (!name || name === 'Narrator' || map[name]) continue;
    let voice = TTS_VOICES.find((v) => !used.has(v));
    if (!voice) voice = TTS_VOICES[cursor % TTS_VOICES.length]; // more characters than voices — start reusing
    cursor++;
    map[name] = voice;
    used.add(voice);
  }
  return map;
}

