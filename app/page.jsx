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
        <h1>나율이의 영어책방</h1>
        <p>책 한 권으로, 하루 10분 영어 말하기</p>
      </header>

      {error && <div className="banner">{error}</div>}

      <Link href="/new" style={{ textDecoration: 'none' }}>
        <button className="btn">✨ 새 책 시작하기</button>
      </Link>

      {loading ? (
        <div className="center"><div className="spinner" /></div>
      ) : books.length > 0 ? (
        <>
          <h2>읽고 있는 책</h2>
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
        </>
      ) : (
        !error && <p className="hint">아직 책이 없어요. 새 책을 시작해보세요.</p>
      )}

      <Link href="/history" style={{ textDecoration: 'none' }}>
        <button className="btn-ghost" style={{ marginTop: 20 }}>📋 지난 리포트 모아보기</button>
      </Link>
    </>
  );
}
