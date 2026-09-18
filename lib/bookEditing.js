export function blankSpread(number, englishText = '') {
  return {
    number,
    englishText,
    sceneDescription: '',
    textUncertain: false,
    error: null,
    tone: 'calm',
    voiceDirection: '',
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

export function mergeEnrichment(spreads, enr) {
  const list = Array.isArray(enr?.spreads) ? enr.spreads : [];
  return spreads.map((s) => {
    const e = list.find((x) => Number(x.number) === s.number) || {};
    return {
      ...s,
      sceneDescription: s.sceneDescription || String(e.scene || ''),
      tone: e.tone || s.tone || 'calm',
      voiceDirection: String(e.voiceDirection || '') || s.voiceDirection || '',
      asides: Array.isArray(e.asides) ? e.asides.slice(0, 2) : s.asides,
      sfx: Array.isArray(e.sfx) ? e.sfx.slice(0, 1) : s.sfx,
      keyVocab: Array.isArray(e.keyVocab) ? e.keyVocab.slice(0, 3) : s.keyVocab,
      speakingValue: Number(e.speakingValue) || s.speakingValue || 3,
    };
  });
}
