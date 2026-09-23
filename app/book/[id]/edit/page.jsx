'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { blankSpread, enrichSpreads, mergeEnrichment, assignCharacterVoices } from '@/lib/bookEditing';
import { precacheSpreads } from '@/lib/audio';

function databaseErrorMessage(error) {
  const message = String(error?.message || error || '저장하지 못했어요.');
  if (/reading_guidance/i.test(message) && /schema cache|column/i.test(message)) {
    return 'Supabase에 책 전체 읽기 안내 컬럼이 아직 없습니다. supabase/add_reading_guidance.sql을 실행한 뒤 다시 저장해주세요.';
  }
  return message;
}

export default function EditBook() {
  const { id } = useParams();
  const router = useRouter();

  const [book, setBook] = useState(null);
  const [busy, setBusy] = useState('로딩 중...');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    (async () => {
      if (!supabaseReady) { setError('Supabase 환경변수가 설정되지 않았습니다.'); setBusy(''); return; }
      const { data, error } = await supabase.from('books').select('*').eq('id', id).single();
      if (error || !data) { setError(error?.message || '책을 찾지 못했어요.'); setBusy(''); return; }
      setBook({
        title: data.title,
        author: data.author || '',
        series: data.series || '',
        readingGuidance: data.reading_guidance || '',
        themes: data.themes || '',
        bookMap: data.book_map || '',
        overallVocab: data.overall_vocab || [],
        characterVoices: data.character_voices || {},
        spreads: (data.spreads || []).map((s, i) => ({ ...blankSpread(s.number ?? i + 1), ...s })),
      });
      setBusy('');
    })();
  }, [id]);

  async function reEnrich() {
    setBusy('다시 정리하고 있어요...');
    setError('');
    setNote('');
    try {
      const enr = await enrichSpreads(book.spreads, { title: book.title, author: book.author, series: book.series, readingGuidance: book.readingGuidance });
      const characterVoices = await assignCharacterVoices(book.characterVoices, enr?.characters);
      setBook((b) => ({
        ...b,
        title: b.title || enr?.title || b.title,
        themes: enr?.themes || b.themes,
        bookMap: enr?.bookMap || b.bookMap || '',
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : b.overallVocab,
        characterVoices,
        spreads: mergeEnrichment(b.spreads, enr),
      }));
      setNote('다시 정리했어요. 목소리 연출도 새로 반영됐어요 — 아래 저장을 눌러주세요.');
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  function updateDialogue(i, updater) {
    const next = [...book.spreads];
    const s = next[i];
    const current = Array.isArray(s.dialogue) && s.dialogue.length ? s.dialogue : [{ speaker: 'Narrator', text: s.englishText }];
    next[i] = { ...s, dialogue: updater([...current.map((d) => ({ ...d }))]) };
    setBook({ ...book, spreads: next });
  }

  const knownCharacters = book ? Object.keys(book.characterVoices || {}) : [];

  // How often has the same question actually come up across every past
  // session of this book? Grouped by exact text (case/spacing-normalized)
  // — a good, honest first pass; near-paraphrases won't group together,
  // but a literal repeat (the most telling sign of a stuck pattern) will.
  const [qFreq, setQFreq] = useState(null);
  const [qFreqLoading, setQFreqLoading] = useState(false);
  async function checkQuestionFrequency() {
    setQFreqLoading(true);
    setQFreq(null);
    try {
      const { data: reports, error } = await supabase.from('reports').select('date, transcript').eq('book_id', id);
      if (error) throw error;
      const counts = new Map(); // normalized key -> { text, count, dates: Set }
      for (const r of reports || []) {
        for (const turn of r.transcript || []) {
          if (turn.role !== 'assistant') continue;
          const text = String(turn.content || '').trim();
          if (!text) continue;
          const key = text.toLowerCase().replace(/\s+/g, ' ');
          if (!counts.has(key)) counts.set(key, { text, count: 0, dates: new Set() });
          const entry = counts.get(key);
          entry.count++;
          entry.dates.add(r.date);
        }
      }
      const list = [...counts.values()]
        .map((e) => ({ text: e.text, count: e.count, dates: [...e.dates].sort() }))
        .sort((a, b) => b.count - a.count);
      setQFreq(list);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setQFreqLoading(false);
    }
  }

  async function save() {
    setBusy('저장하고 있어요...');
    setError('');

    // Pick up any character name typed by hand in the dialogue editor that
    // isn't already voiced — same global voice table re-enrichment uses,
    // so a manually-added speaker gets a consistent voice too.
    const allSpeakers = new Set();
    for (const s of book.spreads) {
      for (const d of s.dialogue || []) {
        if (d.speaker && d.speaker !== 'Narrator') allSpeakers.add(d.speaker);
      }
    }
    const characterVoices = await assignCharacterVoices(book.characterVoices, [...allSpeakers]);

    const { error } = await supabase
      .from('books')
      .update({
        title: book.title.trim() || 'Untitled Story',
        author: book.author || '',
        series: book.series || '',
        reading_guidance: String(book.readingGuidance || '').trim().slice(0, 1200),
        themes: book.themes,
        book_map: book.bookMap || '',
        overall_vocab: book.overallVocab,
        character_voices: characterVoices,
        spreads: book.spreads,
      })
      .eq('id', id);
    if (error) { setBusy(''); setError(databaseErrorMessage(error)); return; }
    setBook((b) => ({ ...b, characterVoices }));

    // Only changed lines actually regenerate — anything already cached
    // (unedited pages) is skipped, so this stays quick on small edits.
    const voice = (typeof window !== 'undefined' && localStorage.getItem('nayul_voice')) || 'coral';
    await precacheSpreads(book.spreads, {
      bookId: id,
      voice,
      characterVoices,
      readingGuidance: book.readingGuidance || '',
      onProgress: (done, total) => setBusy(`읽어주기 음성 준비 중... (${done}/${total})`),
    });

    setBusy('');
    router.push(`/book/${id}`);
  }

  if (busy && !book) {
    return (
      <div className="center">
        <div className="spinner" />
        <p className="hint">{busy}</p>
      </div>
    );
  }

  if (error && !book) {
    return (
      <div className="center">
        <div className="banner">{error}</div>
        <Link href="/"><button className="btn">홈으로</button></Link>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="center">
        <div className="spinner" />
        <p className="hint">{busy}</p>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <Link href={`/book/${id}`}><button className="btn-icon">←</button></Link>
        <span className="title">책 편집하기</span>
        <span style={{ width: 38 }} />
      </div>

      {error && <div className="banner">{error}</div>}
      {note && <div className="banner info">{note}</div>}

      <label className="label">책 제목</label>
      <input
        className="field en"
        value={book.title}
        onChange={(e) => setBook({ ...book, title: e.target.value })}
      />
      <label className="label">저자 (선택)</label>
      <input
        className="field en"
        placeholder="예: Mo Willems"
        value={book.author || ''}
        onChange={(e) => setBook({ ...book, author: e.target.value })}
      />
      <label className="label">시리즈 (선택)</label>
      <input
        className="field en"
        placeholder="예: Elephant & Piggie"
        value={book.series || ''}
        onChange={(e) => setBook({ ...book, series: e.target.value })}
      />
      <label className="label">책 전체 읽기 안내 (선택)</label>
      <textarea
        className="field"
        rows={3}
        maxLength={1200}
        placeholder={'예: 엄마와 함께 읽으면서 같이 이야기해주세요. 웃긴 책이니 목소리 톤을 바꾸고 과장해서 재미있게 읽어주세요.'}
        value={book.readingGuidance || ''}
        onChange={(e) => setBook({ ...book, readingGuidance: e.target.value })}
      />
      <p className="hint" style={{ margin: '4px 0 14px' }}>
        수정한 안내는 다시 저장할 때 모든 페이지 음성과 책 이야기 대화에 반영됩니다.
      </p>
      <p className="hint" style={{ margin: '4px 0 14px' }}>
        저자·시리즈를 채우고 "다시 정리하기"를 누르면, AI가 아는 책이면 그 배경지식을 실감나게 반영합니다.
      </p>
      {book.themes && <p className="hint">{book.themes}</p>}
      {book.bookMap && (
        <div className="banner info" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          <strong>📖 Book Map</strong><br />{book.bookMap}
        </div>
      )}
      {book.characterVoices && Object.keys(book.characterVoices).length > 0 && (
        <p className="hint">
          🎭 등장인물 목소리: {Object.entries(book.characterVoices).map(([name, v]) => `${name}(${v})`).join(', ')}
        </p>
      )}

      {book.spreads.map((s, i) => (
        <div className={`spread-row ${s.error || s.textUncertain ? 'warn' : ''}`} key={s.number}>
          <div className="spread-num">{s.number}</div>
          <div className="spread-body">
            <textarea
              className="field en"
              rows={2}
              placeholder="이 펼침면의 영어 문장을 입력해주세요"
              value={s.englishText}
              onChange={(e) => {
                const next = [...book.spreads];
                next[i] = { ...s, englishText: e.target.value };
                setBook({ ...book, spreads: next });
              }}
            />
            {s.sceneDescription && <div className="spread-scene">{s.sceneDescription}</div>}
            {s.voiceDirection && <div className="spread-scene">🔊 {s.voiceDirection}</div>}

            <label className="label" style={{ marginTop: 8, fontSize: 12.5 }}>
              대사 화자 지정 — AI가 잘못 구분했으면 직접 고쳐주세요
            </label>
            {(Array.isArray(s.dialogue) && s.dialogue.length ? s.dialogue : [{ speaker: 'Narrator', text: s.englishText }]).map((d, di) => (
              <div className="row" style={{ gap: 6, marginTop: 4, alignItems: 'center' }} key={di}>
                <input
                  className="field en"
                  style={{ flex: '0 0 110px', fontSize: 13 }}
                  list="character-names"
                  value={d.speaker}
                  onChange={(e) => updateDialogue(i, (arr) => { arr[di] = { ...arr[di], speaker: e.target.value }; return arr; })}
                />
                <input
                  className="field en"
                  style={{ flex: 1, fontSize: 13 }}
                  value={d.text}
                  onChange={(e) => updateDialogue(i, (arr) => { arr[di] = { ...arr[di], text: e.target.value }; return arr; })}
                />
                <button
                  className="btn-icon"
                  style={{ flexShrink: 0 }}
                  onClick={() => updateDialogue(i, (arr) => arr.filter((_, idx) => idx !== di))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn-text"
              style={{ marginTop: 4 }}
              onClick={() => updateDialogue(i, (arr) => [...arr, { speaker: 'Narrator', text: '' }])}
            >
              + 대사 구간 추가
            </button>
          </div>
        </div>
      ))}

      <datalist id="character-names">
        <option value="Narrator" />
        {knownCharacters.map((c) => <option key={c} value={c} />)}
      </datalist>

      <button
        className="btn-ghost"
        onClick={() => setBook({ ...book, spreads: [...book.spreads, blankSpread(book.spreads.length + 1)] })}
      >
        ＋ 펼침면 추가
      </button>
      <button className="btn-ghost" onClick={reEnrich}>✨ 입력한 문장으로 다시 정리하기</button>

      <button className="btn-ghost" onClick={checkQuestionFrequency} disabled={qFreqLoading}>
        {qFreqLoading ? '확인 중...' : '📊 질문 반복 빈도 확인'}
      </button>
      {qFreq && (
        qFreq.length === 0 ? (
          <p className="hint">아직 대화 기록이 없어요.</p>
        ) : (
          <div className="vocab-list">
            {qFreq.map((q, i) => (
              <div className="vocab-word" key={i}>
                <div className="vocab-word-head">
                  <span style={{ fontWeight: 700 }}>{q.count}회</span>
                  {q.count >= 2 && <span style={{ color: 'var(--rose)', fontSize: 12 }}>⚠ 반복됨</span>}
                </div>
                <div className="en" style={{ fontSize: 14, marginTop: 2 }}>{q.text}</div>
                <div className="vocab-def">{q.dates.join(', ')}</div>
              </div>
            ))}
          </div>
        )
      )}

      <button className="btn" style={{ marginTop: 14 }} onClick={save}>저장하기</button>
    </>
  );
}
