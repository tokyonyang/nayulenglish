'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { downloadCSV } from '@/lib/report';

export default function History() {
  const [reports, setReports] = useState([]);
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      if (!supabaseReady) { setError('Supabase 환경변수가 설정되지 않았습니다.'); setLoading(false); return; }
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) setError(error.message);
      else setReports(data || []);
      setLoading(false);
    })();
  }, []);

  const detailRows = (r) => [
    ['총 스피킹시간', `${r.total_minutes}분`],
    ['책 대화 / 일상 대화', `${r.stage2_minutes}분 / ${r.stage3_minutes}분`],
    ['자발 단어응답', r.word_spont],
    ['자발 불완전구/문장', r.phrase_spont],
    ['자발 완전문장', r.sent_spont],
    ['힌트 후 문장', r.hint_sent],
    ['모델링 후 문장', r.model_sent],
    ['최고 발화 레벨', r.best_level],
    ['새 표현어휘', r.new_vocab || '-'],
    ['자발 사용어휘', r.spont_vocab || '-'],
    ['Why 질문 이해도', r.why_understanding],
    ['기타 질문 이해도', r.other_understanding],
    ['문장 확장 성공', r.expansions],
    ['참여도', r.engagement],
    ['오늘 최고 발화', r.best_quote],
    ['어려웠던 점', r.difficulty],
    ['다음 세션 목표', r.next_goal],
  ];

  return (
    <>
      <div className="topbar">
        <Link href="/"><button className="btn-icon">←</button></Link>
        <span className="title">지난 리포트</span>
        <span style={{ width: 38 }} />
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && <div className="center"><div className="spinner" /></div>}

      {!loading && reports.length === 0 && !error && <p className="hint">아직 리포트가 없어요.</p>}

      {reports.length > 0 && (
        <button
          className="btn-ghost"
          onClick={() => downloadCSV(reports, '나율이_영어스피킹_전체리포트.csv')}
        >
          ⬇ 전체 CSV 다운로드
        </button>
      )}

      {reports.map((r) => (
        <div className="card" key={r.id} style={{ padding: 0 }}>
          <button
            style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '13px 14px', fontSize: 13.5, fontWeight: 600, textAlign: 'left' }}
            onClick={() => setOpen(open === r.id ? null : r.id)}
          >
            <span>{r.date} · {r.book_title} (Day {r.day})</span>
            <span style={{ color: 'var(--ink-soft)' }}>{open === r.id ? '▴' : '▾'}</span>
          </button>
          {open === r.id && (
            <div style={{ padding: '0 14px 14px' }}>
              <div className="report-grid">
                {detailRows(r).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <div className="report-k">{k}</div>
                    <div>{v ?? '-'}</div>
                  </div>
                ))}
              </div>
              {r.comment && <div className="report-comment">{r.comment}</div>}
              <button className="btn-ghost" onClick={() => downloadCSV([r], `나율이_리포트_${r.date}.csv`)}>
                ⬇ 이 리포트만 CSV
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
