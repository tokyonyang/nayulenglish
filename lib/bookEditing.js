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
  // Strict check — every word of the original page must survive the split
  // into speakers. A model that drops a short line (e.g. "Thank you!")
  // between two longer ones can still look "close enough" on a loose
  // length check, so we require an exact word-for-word match (ignoring
  // case, spacing, and punctuation the model was told it could drop, like
  // quote marks) and fall back to a single Narrator line — the whole
  // original text, nothing missing — on any mismatch at all.
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const joined = dialogue.map((d) => String(d?.text || '')).join(' ');
  const a = normalize(joined);
  const b = normalize(fallbackText);
  return b.length === 0 || a === b;
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

