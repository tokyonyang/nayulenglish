'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';

export default function Home() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    if (!supabaseReady) {
      setError('Supabase 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 NEXT_PUBLIC_SUPABASE_URL 과 NEXT_PUBLIC_SUPABASE_ANON_KEY 를 넣어주세요.');
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setBooks(data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id) {
    if (!confirm('이 책과 관련 리포트를 모두 삭제할까요?')) return;
    await supabase.from('books').delete().eq('id', id);
    setBooks((b) => b.filter((x) => x.id !== id));
  }

  return (
    <>
      <header className="header">
        <div className="emoji">📖</div>
        <h1>hohobook</h1>
        <p>나율이의 영어책방 · 아이와 영어 그림책을 읽고 대화하는 개인 학습 도구</p>
      </header>

      <section
        style={{
          margin: '18px 0 24px',
          padding: '18px',
          borderRadius: '18px',
          background: 'rgba(255,255,255,0.7)',
          lineHeight: 1.7,
        }}
      >
        <h2 style={{ marginTop: 0 }}>hohobook 소개</h2>
        <p style={{ marginBottom: 8 }}>
          hohobook은 영어 그림책을 등록하고, 책 읽기와 대화 활동을 기록할 수 있도록 만든 개인 학습 도구입니다.
        </p>
        <p style={{ margin: 0 }}>
          Google Drive 연동은 사용자가 앱에서 선택하거나 생성한 파일을 저장하고 불러오기 위한 용도로만 사용됩니다.
        </p>
      </section>

      {error && <div className="banner">{error}</div>}

      <Link href="/new" style={{ textDecoration: 'none' }}>
        <button className="btn">✨ 새 책 시작하기</button>
      </Link>

      {loading ? (
        <div className="center"><div className="spinner" /></div>
      ) : books.length > 0 ? (
        <>
          <h2>읽고 있는 책</h2>
          <div className="card-grid">
            {books.map((b) => (
              <div className="card" key={b.id}>
                <div className="card-title">{b.title}</div>
                <div className="card-meta">
                  펼침면 {(b.spreads || []).length}장 · {b.sessions_count || 0}일째 진행
                </div>
                <div className="card-actions">
                  <Link href={`/book/${b.id}`} style={{ flex: 1, textDecoration: 'none' }}>
                    <button className="btn">오늘 세션 시작 →</button>
                  </Link>
                  <Link href={`/book/${b.id}/edit`}>
                    <button className="btn-text">편집</button>
                  </Link>
                  <button className="btn-text" onClick={() => remove(b.id)}>삭제</button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        !error && <p className="hint">아직 책이 없어요. 새 책을 시작해보세요.</p>
      )}

      <Link href="/history" style={{ textDecoration: 'none' }}>
        <button className="btn-ghost" style={{ marginTop: 20 }}>📋 지난 리포트 모아보기</button>
      </Link>

      <footer
        style={{
          marginTop: 40,
          padding: '24px 0 8px',
          textAlign: 'center',
          fontSize: 14,
          opacity: 0.8,
        }}
      >
        <strong>hohobook</strong>
        <div style={{ marginTop: 8 }}>
          <Link href="/privacy">개인정보처리방침</Link>
        </div>
      </footer>
    </>
  );
}
