export const REPORT_COLUMNS = [
  ['date', '날짜'],
  ['book_title', '책 제목'],
  ['day', 'Day'],
  ['total_minutes', '총 스피킹시간(분)'],
  ['stage2_minutes', '책 대화시간(분)'],
  ['stage3_minutes', '일상 대화시간(분)'],
  ['word_spont', '자발 단어응답'],
  ['phrase_spont', '자발 불완전구/문장'],
  ['sent_spont', '자발 완전문장'],
  ['hint_sent', '힌트 후 문장'],
  ['model_sent', '모델링 후 문장'],
  ['best_level', '최고 발화 레벨'],
  ['new_vocab', '새 표현어휘'],
  ['spont_vocab', '자발 사용어휘'],
  ['why_understanding', 'Why 질문 이해도'],
  ['other_understanding', '기타 질문 이해도'],
  ['expansions', '문장 확장 성공'],
  ['engagement', '참여도'],
  ['best_quote', '오늘 최고 발화'],
  ['difficulty', '어려웠던 점'],
  ['next_goal', '다음 세션 목표'],
  ['comment', '종합 코멘트'],
];

const RANK = { none: -1, korean: 0, word: 1, phrase: 2, simple_sentence: 3, extended_sentence: 4 };
const LABEL = {
  word: '단어',
  phrase: '짧은 구',
  simple_sentence: '완전한 문장',
  extended_sentence: '확장된 문장',
  korean: '한국어 응답',
  none: '-',
};
const LEVEL_KO = { spontaneous: '자발', prompted: '힌트 후', modeled: '모델링 후' };

export function tally(logs) {
  const out = {
    wordSpont: 0,
    phraseSpont: 0,
    sentSpont: 0,
    hintSent: 0,
    modelSent: 0,
    maxRank: -1,
    maxLabel: '-',
    bestLevel: null,
    bestUtterance: null,
    expansions: 0,
    newVocab: new Set(),
    spontVocab: new Set(),
  };

  for (const e of logs) {
    const t = e.childUtteranceType || 'none';
    const lvl = e.childSupportLevel;

    if (lvl === 'spontaneous') {
      if (t === 'word') out.wordSpont++;
      else if (t === 'phrase') out.phraseSpont++;
      else if (t === 'simple_sentence' || t === 'extended_sentence') out.sentSpont++;
    } else if (lvl === 'prompted' && t !== 'none') out.hintSent++;
    else if (lvl === 'modeled' && t !== 'none') out.modelSent++;

    const r = RANK[t] ?? -1;
    if (r > out.maxRank || (r === out.maxRank && lvl === 'spontaneous' && out.bestLevel !== 'spontaneous')) {
      out.maxRank = r;
      out.maxLabel = LABEL[t] || '-';
      out.bestLevel = lvl;
      out.bestUtterance = e.childText;
    }

    if (e.expansionGiven) out.expansions++;
    (e.newVocabIntroduced || []).forEach((v) => out.newVocab.add(v));
    if (lvl === 'spontaneous') (e.vocabUsedByChild || []).forEach((v) => out.spontVocab.add(v));
  }
  return out;
}

export function bestLevelLabel(stats) {
  if (stats.maxRank < 0) return '-';
  return `${stats.maxLabel}${stats.bestLevel ? ` (${LEVEL_KO[stats.bestLevel] || ''})` : ''}`;
}

export function pairStats(log) {
  const why = { t: 0, u: 0 };
  const other = { t: 0, u: 0 };
  for (let i = 0; i < log.length - 1; i++) {
    const q = log[i].questionType;
    if (!q) continue;
    const next = log[i + 1];
    const understood = next.childSupportLevel === 'spontaneous' || next.childSupportLevel === 'prompted';
    if (q === 'why') {
      why.t++;
      if (understood) why.u++;
    } else {
      other.t++;
      if (understood) other.u++;
    }
  }
  return { why, other };
}

export function transcriptSummary(label, turns) {
  const lines = [`[${label}]`];
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i];
    lines.push((t.role === 'assistant' ? '선생님: ' : '나율: ') + t.content);
  }
  return lines.join('\n');
}

export function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n...(중략)...\n${text.slice(text.length - half)}`;
}

function csvEscape(s) {
  const v = String(s ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCSV(reports) {
  const header = REPORT_COLUMNS.map((c) => c[1]);
  const rows = reports.map((r) => REPORT_COLUMNS.map((c) => csvEscape(r[c[0]])));
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function downloadCSV(reports, filename) {
  const csv = `\uFEFF${toCSV(reports)}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
