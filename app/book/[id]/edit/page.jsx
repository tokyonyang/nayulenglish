'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { blankSpread, enrichSpreads, mergeEnrichment } from '@/lib/bookEditing';
import { precacheSpreads } from '@/lib/audio';

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
        themes: data.themes || '',
        overallVocab: data.overall_vocab || [],
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
      const enr = await enrichSpreads(book.spreads);
      setBook((b) => ({
        ...b,
        title: enr?.title || b.title,
        themes: enr?.themes || b.themes,
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : b.overallVocab,
        spreads: mergeEnrichment(b.spreads, enr),
      }));
      setNote('다시 정리했어요. 목소리 연출도 새로 반영됐어요 — 아래 저장을 눌러주세요.');
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  async function save() {
    setBusy('저장하고 있어요...');
    setError('');
    const { error } = await supabase
      .from('books')
      .update({
        title: book.title.trim() || 'Untitled Story',
        themes: book.themes,
        overall_vocab: book.overallVocab,
        spreads: book.spreads,
      })
      .eq('id', id);
    if (error) { setBusy(''); setError(error.message); return; }

    // Only changed lines actually regenerate — anything already cached
    // (unedited pages) is skipped, so this stays quick on small edits.
    const voice = (typeof window !== 'undefined' && localStorage.getItem('nayul_voice')) || 'coral';
    await precacheSpreads(book.spreads, {
      voice,
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
      {book.themes && <p className="hint">{book.themes}</p>}

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
          </div>
        </div>
      ))}

      <button
        className="btn-ghost"
        onClick={() => setBook({ ...book, spreads: [...book.spreads, blankSpread(book.spreads.length + 1)] })}
      >
        ＋ 펼침면 추가
      </button>
      <button className="btn-ghost" onClick={reEnrich}>✨ 입력한 문장으로 다시 정리하기</button>
      <button className="btn" style={{ marginTop: 14 }} onClick={save}>저장하기</button>
    </>
  );
}
