'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';

function blankSpread(number, englishText = '') {
  return {
    number,
    englishText,
    sceneDescription: '',
    textUncertain: false,
    error: null,
    tone: 'calm',
    asides: [],
    sfx: [],
    keyVocab: [],
    speakingValue: 3,
  };
}

async function convertOnce(file, maxSide, quality) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  } catch (e) {
    console.error('convert failed', e);
    return null;
  }
}

// Vercel Functions cap request bodies around 4.5MB. Modern phone cameras
// routinely shoot 8MB+ originals, so every photo gets compressed down to a
// safe per-image size first, then batches are packed by *actual* converted
// size (not a fixed photo count) so any mix of book pages fits reliably.
const PER_IMAGE_CAP_BYTES = 1.2 * 1024 * 1024;
const BATCH_BUDGET_BYTES = 3.2 * 1024 * 1024;

/** Downscale to JPEG so huge iPhone photos (and HEIC on Safari) upload
 *  reliably, shrinking further in steps until it's safely under the cap —
 *  one pass isn't always enough for a very detailed high-res original. */
async function toJpegCapped(file) {
  let side = 1500;
  let quality = 0.85;
  let blob = await convertOnce(file, side, quality);
  if (!blob) return file; // canvas failed entirely — send original, server tolerates it

  for (let attempt = 0; attempt < 4 && blob.size > PER_IMAGE_CAP_BYTES; attempt++) {
    quality = Math.max(0.5, quality - 0.15);
    side = Math.max(700, Math.round(side * 0.8));
    const next = await convertOnce(file, side, quality);
    if (next) blob = next;
  }
  return new File([blob], 'spread.jpg', { type: 'image/jpeg' });
}

export default function NewBook() {
  const router = useRouter();
  const [files, setFiles] = useState([]);
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [book, setBook] = useState(null);

  function moveFile(i, dir) {
    setFiles((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function enrich(spreads) {
    const res = await fetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreads }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function merge(spreads, enr) {
    const list = Array.isArray(enr?.spreads) ? enr.spreads : [];
    return spreads.map((s) => {
      const e = list.find((x) => Number(x.number) === s.number) || {};
      return {
        ...s,
        sceneDescription: s.sceneDescription || String(e.scene || ''),
        tone: e.tone || s.tone || 'calm',
        asides: Array.isArray(e.asides) ? e.asides.slice(0, 2) : s.asides,
        sfx: Array.isArray(e.sfx) ? e.sfx.slice(0, 1) : s.sfx,
        keyVocab: Array.isArray(e.keyVocab) ? e.keyVocab.slice(0, 3) : s.keyVocab,
        speakingValue: Number(e.speakingValue) || s.speakingValue || 3,
      };
    });
  }

  async function scanPhotos() {
    setError('');
    try {
      const converted = [];
      for (let i = 0; i < files.length; i++) {
        setBusy(`사진 압축 중... (${i + 1}/${files.length})`);
        converted.push(await toJpegCapped(files[i]));
      }

      // Pack by actual converted size, not a fixed photo count — however
      // many fit under the budget go in one request.
      const batches = [];
      let cur = [];
      let curBytes = 0;
      for (const f of converted) {
        if (cur.length && curBytes + f.size > BATCH_BUDGET_BYTES) {
          batches.push(cur);
          cur = [];
          curBytes = 0;
        }
        cur.push(f);
        curBytes += f.size;
      }
      if (cur.length) batches.push(cur);

      const spreads = [];
      let done = 0;
      let numberCursor = 1;
      for (const batch of batches) {
        setBusy(`사진 읽는 중... (${done + batch.length}/${converted.length}장)`);
        const form = new FormData();
        batch.forEach((f) => form.append('photos', f));
        form.append('start', String(numberCursor));
        try {
          const res = await fetch('/api/scan', { method: 'POST', body: form });
          if (!res.ok) throw new Error(await res.text());
          const { spreads: batchSpreads } = await res.json();
          spreads.push(...batchSpreads);
        } catch (e) {
          console.error('batch failed', numberCursor, e);
          batch.forEach((_, j) => spreads.push({
            number: numberCursor + j, englishText: '', sceneDescription: '',
            textUncertain: true, error: String(e.message || e).slice(0, 200),
          }));
        }
        numberCursor += batch.length;
        done += batch.length;
      }

      const base = spreads.map((s) => ({ ...blankSpread(s.number, s.englishText), ...s }));
      setBusy('책 전체 이야기를 정리하고 있어요...');
      let enr = null;
      if (base.some((s) => s.englishText.trim())) {
        try { enr = await enrich(base); } catch (e) { console.error(e); }
      }
      setBook({
        title: enr?.title || 'My Picture Book',
        themes: enr?.themes || '',
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : [],
        spreads: merge(base, enr),
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  async function buildFromText() {
    setError('');
    const raw = bulk.trim();
    if (!raw) { setError('책 문장을 먼저 입력해주세요.'); return; }
    let chunks = raw.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
    if (chunks.length === 1) chunks = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const base = chunks.map((t, i) => blankSpread(i + 1, t));

    setBusy('책을 정리하고 있어요...');
    try {
      const enr = await enrich(base);
      setBook({
        title: enr?.title || 'My Picture Book',
        themes: enr?.themes || '',
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : [],
        spreads: merge(base, enr),
      });
    } catch (e) {
      setError(String(e.message || e));
      setBook({ title: 'My Picture Book', themes: '', overallVocab: [], spreads: base });
    } finally {
      setBusy('');
    }
  }

  async function reEnrich() {
    setBusy('다시 정리하고 있어요...');
    setError('');
    try {
      const enr = await enrich(book.spreads);
      setBook((b) => ({
        ...b,
        title: enr?.title || b.title,
        themes: enr?.themes || b.themes,
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : b.overallVocab,
        spreads: merge(b.spreads, enr),
      }));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  async function save() {
    if (!supabaseReady) { setError('Supabase 환경변수가 없어서 저장할 수 없어요.'); return; }
    if (!book.spreads.some((s) => (s.englishText || '').trim())) {
      if (!confirm('아직 읽어줄 문장이 하나도 없어요. 이대로 저장할까요?')) return;
    }
    setBusy('저장하고 있어요...');
    const { data, error } = await supabase
      .from('books')
      .insert({
        title: book.title.trim() || 'Untitled Story',
        themes: book.themes,
        overall_vocab: book.overallVocab,
        spreads: book.spreads,
      })
      .select()
      .single();
    setBusy('');
    if (error) { setError(error.message); return; }
    router.push(`/book/${data.id}`);
  }

  if (busy) {
    return (
      <div className="center">
        <div className="spinner" />
        <p className="hint">{busy}</p>
      </div>
    );
  }

  if (book) {
    return (
      <>
        <div className="topbar">
          <button className="btn-icon" onClick={() => setBook(null)}>←</button>
          <span className="title">책 확인하기</span>
          <span style={{ width: 38 }} />
        </div>

        {error && <div className="banner">{error}</div>}

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
              {s.error && <div className="spread-warn">⚠ 이 장을 읽지 못했어요 — 직접 입력해주세요</div>}
              {!s.error && s.textUncertain && <div className="spread-warn">⚠ 글씨가 흐릿했어요 — 확인해주세요</div>}
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
        <button className="btn" style={{ marginTop: 14 }} onClick={save}>저장하고 오늘 세션 시작하기 →</button>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <Link href="/"><button className="btn-icon">←</button></Link>
        <span className="title">새 책 시작</span>
        <span style={{ width: 38 }} />
      </div>

      {error && <div className="banner">{error}</div>}

      <h2>방법 1 · 사진으로 만들기</h2>
      <p className="hint">
        펼침면 순서대로 사진을 찍어 한 번에 선택해주세요. (표지 제외) 아이폰 사진은 자동으로 JPG로 변환해서 올립니다.
      </p>
      <label className="file-drop">
        📷 사진 선택하기
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { setFiles((p) => [...p, ...Array.from(e.target.files || [])]); e.target.value = ''; }}
        />
      </label>
      <p className="hint" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
        선택된 사진: {files.length}장
      </p>

      {files.length > 0 && (
        <>
          <div className="thumbs">
            {files.map((f, i) => (
              <div className="thumb" key={`${f.name}-${f.size}-${i}`}>
                <img
                  src={URL.createObjectURL(f)}
                  alt=""
                  onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.add('show'); }}
                />
                <div className="thumb-fallback">🖼<br />{f.name.slice(0, 14)}</div>
                <span className="num">{i + 1}</span>
                <span className="filesize">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                <div className="acts">
                  <button onClick={() => moveFile(i, -1)}>▲</button>
                  <button onClick={() => moveFile(i, 1)}>▼</button>
                  <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={scanPhotos}>사진 {files.length}장 분석 시작</button>
        </>
      )}

      <h2>방법 2 · 문장 입력으로 만들기</h2>
      <p className="hint">
        책 문장을 순서대로 입력하고, <b>펼침면 사이는 빈 줄 한 칸</b>으로 구분해주세요.
      </p>
      <textarea
        className="field en"
        rows={8}
        placeholder={'Oh, well...\nThis works too.\n\nI will share my ice cream.\n\nThank you!'}
        value={bulk}
        onChange={(e) => setBulk(e.target.value)}
      />
      <button className="btn-ghost" onClick={buildFromText}>✨ 문장으로 책 만들기</button>
    </>
  );
}
