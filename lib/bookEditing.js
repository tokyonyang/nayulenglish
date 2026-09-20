import { TTS_VOICES } from '@/lib/audio';
import { supabase, supabaseReady } from '@/lib/supabase';

// Auto-assignment prefers bright, lively-sounding voices first — a fixed
// alphabetical-ish order was quietly favoring flatter/deeper voices (onyx,
// cedar) just because they came up sooner, giving books an overall low,
// low-energy feel. onyx (explicitly deep/resonant) is kept but goes last,
// used only once every brighter option is already taken by another
// character in the same book.
const CHARACTER_VOICE_PRIORITY = [
  'nova', 'shimmer', 'ash', 'coral', 'marin', 'verse', 'ballad', 'fable',
  'sage', 'alloy', 'echo', 'cedar', 'juniper', 'onyx',
].filter((v) => TTS_VOICES.includes(v));

function normalizeCharacterKey(name) {
  return String(name || '').trim().toLowerCase();
}

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

export async function enrichSpreads(spreads, bookMeta) {
  const res = await fetch('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spreads, bookMeta }),
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

/** Assigns each newly-seen character a TTS voice. Checks the book-wide
 *  shared `character_voices` table FIRST (keyed by normalized name), so a
 *  character who already has a voice from ANY other book (e.g. Gerald in
 *  a different Elephant & Piggie title) gets that same voice here — that's
 *  what "same character, different voice across books" was missing. Only
 *  a character nobody has ever seen before gets a fresh pick, biased
 *  toward brighter voices, and that pick is saved back to the shared
 *  table so every future book reuses it too. `existing` (this book's own
 *  prior map, if any) is still honored so a book never reassigns a
 *  character mid-way through its own life either. */
export async function assignCharacterVoices(existing, characters) {
  const map = { ...(existing || {}) };
  const names = (characters || []).filter((n) => n && n !== 'Narrator');
  if (!names.length) return map;

  const keyToName = new Map(names.map((n) => [normalizeCharacterKey(n), n]));
  let globalMap = {};
  if (supabaseReady) {
    try {
      const { data } = await supabase
        .from('character_voices')
        .select('character_key, voice')
        .in('character_key', [...keyToName.keys()]);
      for (const row of data || []) {
        const name = keyToName.get(row.character_key);
        if (name) globalMap[name] = row.voice;
      }
    } catch (e) {
      console.error('global character voice lookup failed', e);
    }
  }

  // The shared table is the source of truth: sync to it even if this book
  // already had a DIFFERENT voice for this character from before it was
  // ever shared — that stale local value is exactly the inconsistency
  // "다시 정리하기" is supposed to fix.
  for (const name of names) {
    if (globalMap[name]) map[name] = globalMap[name];
  }

  const used = new Set(Object.values(map));
  const toPublish = [];
  for (const name of names) {
    if (map[name]) {
      // Has a voice (from the shared table, or a pre-existing book-local
      // pick with no shared entry yet) but isn't published — publish it so
      // any OTHER book featuring this character inherits the same voice.
      if (!globalMap[name]) toPublish.push({ character_key: normalizeCharacterKey(name), display_name: name, voice: map[name] });
      continue;
    }
    let voice = CHARACTER_VOICE_PRIORITY.find((v) => !used.has(v));
    if (!voice) voice = CHARACTER_VOICE_PRIORITY[toPublish.length % CHARACTER_VOICE_PRIORITY.length];
    map[name] = voice;
    used.add(voice);
    toPublish.push({ character_key: normalizeCharacterKey(name), display_name: name, voice });
  }

  if (toPublish.length && supabaseReady) {
    supabase
      .from('character_voices')
      .upsert(toPublish, { onConflict: 'character_key' })
      .then(({ error }) => { if (error) console.error('save global character voice failed', error); });
  }

  return map;
}

