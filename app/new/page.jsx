'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { blankSpread, enrichSpreads, mergeEnrichment, assignCharacterVoices } from '@/lib/bookEditing';
import { precacheSpreads, storeMediaBlob } from '@/lib/audio';

/** Picture books often print a small page number on each page. If most
 *  scanned spreads have one and they're all distinct, use it to reorder —
 *  so parents don't have to photograph pages in exact reading order.
 *  Spreads with no detected number (or if too few books show numbers)
 *  fall back to upload order, appended at the end for manual placement. */
function autoOrderSpreads(scanned) {
  const total = scanned.length;
  const withPage = scanned.filter((s) => Number.isFinite(s.detectedPage));
  const uniquePages = new Set(withPage.map((s) => s.detectedPage)).size === withPage.length;

  if (total >= 2 && withPage.length / total >= 0.7 && uniquePages) {
    const numbered = [...withPage].sort((a, b) => a.detectedPage - b.detectedPage);
    const unnumbered = scanned
      .filter((s) => !Number.isFinite(s.detectedPage))
      .sort((a, b) => a.number - b.number);
    const ordered = [...numbered, ...unnumbered].map((s, i) => ({ ...s, number: i + 1 }));
    return { spreads: ordered, autoSorted: true, unplacedCount: unnumbered.length };
  }
  return {
    spreads: [...scanned].sort((a, b) => a.number - b.number),
    autoSorted: false,
    unplacedCount: 0,
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
  const [draftId] = useState(() => crypto.randomUUID());
  const [files, setFiles] = useState([]);
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [book, setBook] = useState(null);
  const [meta, setMeta] = useState({ title: '', author: '', series: '' });
  const [coverFile, setCoverFile] = useState(null);
  const [identifying, setIdentifying] = useState(false);

  async function identifyCover() {
    if (!coverFile) return;
    setIdentifying(true);
    setError('');
    try {
      const converted = await toJpegCapped(coverFile);
      const form = new FormData();
      form.append('cover', converted);
      const res = await fetch('/api/identify-cover', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMeta((m) => ({
        title: data.title || m.title,
        author: data.author || m.author,
        series: data.series || m.series,
      }));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setIdentifying(false);
    }
  }

  function moveFile(i, dir) {
    setFiles((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const enrich = enrichSpreads;
  const merge = mergeEnrichment;

  async function scanPhotos() {
    setError('');
    setNote('');
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
          batchSpreads.forEach((s, j) => spreads.push({ ...s, photo: batch[j] || null }));
        } catch (e) {
          console.error('batch failed', numberCursor, e);
          batch.forEach((f, j) => spreads.push({
            number: numberCursor + j, englishText: '', sceneDescription: '',
            textUncertain: true, error: String(e.message || e).slice(0, 200), photo: f,
          }));
        }
        numberCursor += batch.length;
        done += batch.length;
        if (done < converted.length) await new Promise((r) => setTimeout(r, 400));
      }

      const { spreads: ordered, autoSorted, unplacedCount } = autoOrderSpreads(spreads);
      const base = ordered.map((s) => ({ ...blankSpread(s.number, s.englishText), ...s }));
      setBusy('책 전체 이야기를 정리하고 있어요...');
      let enr = null;
      if (base.some((s) => s.englishText.trim())) {
        try { enr = await enrich(base, meta); } catch (e) { console.error(e); }
      }
      setNote(
        autoSorted
          ? unplacedCount > 0
            ? `책에 인쇄된 페이지 번호를 읽어서 순서를 자동 정렬했어요. 번호를 못 찾은 ${unplacedCount}장은 맨 뒤에 넣어뒀으니 맞는 자리로 옮겨주세요.`
            : '책에 인쇄된 페이지 번호를 읽어서 순서를 자동 정렬했어요. 확인해보시고 다르면 ▲▼로 조정해주세요.'
          : '페이지 번호를 충분히 찾지 못해 업로드하신 순서를 그대로 사용했어요. 순서가 다르면 ▲▼로 조정해주세요.'
      );
      const characterVoices = await assignCharacterVoices({}, enr?.characters);
      setBook({
        title: meta.title || enr?.title || 'My Picture Book',
        author: meta.author || '',
        series: meta.series || '',
        themes: enr?.themes || '',
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : [],
        characterVoices,
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
    setNote('');
    const raw = bulk.trim();
    if (!raw) { setError('책 문장을 먼저 입력해주세요.'); return; }
    let chunks = raw.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
    if (chunks.length === 1) chunks = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const base = chunks.map((t, i) => blankSpread(i + 1, t));

    setBusy('책을 정리하고 있어요...');
    try {
      const enr = await enrich(base, meta);
      const characterVoices = await assignCharacterVoices({}, enr?.characters);
      setBook({
        title: meta.title || enr?.title || 'My Picture Book',
        author: meta.author || '',
        series: meta.series || '',
        themes: enr?.themes || '',
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : [],
        characterVoices,
        spreads: merge(base, enr),
      });
    } catch (e) {
      setError(String(e.message || e));
      setBook({ title: meta.title || 'My Picture Book', author: meta.author || '', series: meta.series || '', themes: '', overallVocab: [], characterVoices: {}, spreads: base });
    } finally {
      setBusy('');
    }
  }

  async function reEnrich() {
    setBusy('다시 정리하고 있어요...');
    setError('');
    try {
      const enr = await enrich(book.spreads, { title: book.title, author: book.author, series: book.series });
      const characterVoices = await assignCharacterVoices(book.characterVoices, enr?.characters);
      setBook((b) => ({
        ...b,
        title: b.title || enr?.title || b.title,
        themes: enr?.themes || b.themes,
        overallVocab: Array.isArray(enr?.overallVocab) ? enr.overallVocab : b.overallVocab,
        characterVoices,
        spreads: merge(b.spreads, enr),
      }));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  }


  async function retryFailed() {
    const failed = book.spreads.filter((s) => s.error && s.photo);
    if (!failed.length) return;
    setError('');
    setNote('');
    const updated = [...book.spreads];
    for (let i = 0; i < failed.length; i++) {
      const s = failed[i];
      setBusy(`실패한 페이지 다시 시도 중... (${i + 1}/${failed.length})`);
      try {
        const form = new FormData();
        form.append('photos', s.photo);
        form.append('start', String(s.number));
        const res = await fetch('/api/scan', { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());
        const { spreads: result } = await res.json();
        const r = result[0];
        const idx = updated.findIndex((x) => x.number === s.number);
        if (idx !== -1 && r) {
          updated[idx] = {
            ...updated[idx],
            englishText: r.englishText || updated[idx].englishText,
            sceneDescription: r.sceneDescription || updated[idx].sceneDescription,
            textUncertain: Boolean(r.textUncertain),
            error: r.error || null,
          };
        }
      } catch (e) {
        console.error('retry failed', s.number, e);
      }
      if (i < failed.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    setBook((b) => ({ ...b, spreads: updated }));
    const stillFailed = updated.filter((s) => s.error).length;
    setNote(stillFailed ? `${stillFailed}장은 여전히 실패했어요. 직접 입력해주시거나 다시 시도해주세요.` : '모두 성공했어요!');
    setBusy('');
  }

  async function save() {
    if (!supabaseReady) { setError('Supabase 환경변수가 없어서 저장할 수 없어요.'); return; }
    if (!book.spreads.some((s) => (s.englishText || '').trim())) {
      if (!confirm('아직 읽어줄 문장이 하나도 없어요. 이대로 저장할까요?')) return;
    }
    setBusy('저장하고 있어요...');
    const cleanSpreads = book.spreads.map(({ photo, error, textUncertain, detectedPage, ...rest }) => rest);
    const { data, error } = await supabase
      .from('books')
      .upsert({
        id: draftId,
        title: book.title.trim() || 'Untitled Story',
        author: book.author || '',
        series: book.series || '',
        themes: book.themes,
        overall_vocab: book.overallVocab,
        character_voices: book.characterVoices || {},
        spreads: cleanSpreads,
      }, { onConflict: 'id' })
      .select()
      .single();
    if (error) { setBusy(''); setError(error.message); return; }

    // Photos are stored separately, one file per spread, so Stage 1 can
    // show the actual page while it reads — not just the extracted text.
    const withPhotos = book.spreads.filter((s) => s.photo);
    for (let i = 0; i < withPhotos.length; i++) {
      setBusy(`사진 저장 중... (${i + 1}/${withPhotos.length})`);
      const s = withPhotos[i];
      try {
        await storeMediaBlob({
          bucket: 'book-photos',
          path: `${data.id}/${s.number}.jpg`,
          bookId: data.id,
          blob: s.photo,
        });
      } catch (e) {
        console.error('photo upload failed', s.number, e);
        setBusy('');
        setError(`펼침면 ${s.number} 사진을 Drive에 저장하지 못했어요. 잠시 후 저장을 다시 눌러주세요.`);
        return;
      }
    }

    // Pre-build every read-aloud clip now, so the first actual reading
    // session plays instantly instead of generating page-by-page.
    const voice = (typeof window !== 'undefined' && localStorage.getItem('nayul_voice')) || 'coral';
    await precacheSpreads(cleanSpreads, {
      bookId: data.id,
      voice,
      characterVoices: book.characterVoices || {},
      onProgress: (done, total) => setBusy(`읽어주기 음성 미리 준비 중... (${done}/${total})`),
    });

    setBusy('');
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
          <button className="btn-icon" onClick={() => { setBook(null); setNote(''); }}>←</button>
          <span className="title">책 확인하기</span>
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
        <p className="hint" style={{ margin: '4px 0 14px' }}>
          저자·시리즈를 채우고 "다시 정리하기"를 누르면, AI가 아는 책이면 그 배경지식을 실감나게 반영합니다.
        </p>
        {book.themes && <p className="hint">{book.themes}</p>}
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
              {s.error && <div className="spread-warn">⚠ 이 장을 읽지 못했어요 — 직접 입력해주세요</div>}
              {!s.error && s.textUncertain && <div className="spread-warn">⚠ 글씨가 흐릿했어요 — 확인해주세요</div>}
            </div>
          </div>
        ))}

        {book.spreads.some((s) => s.error) && (
          <button className="btn-ghost" onClick={retryFailed}>⟳ 실패한 페이지만 다시 시도</button>
        )}
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

      <h2>책 정보 (선택이지만, 넣으면 훨씬 실감나게 읽어줍니다)</h2>
      <label className="label">표지 사진으로 자동 채우기</label>
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="file-drop" style={{ flex: 1, padding: '14px' }}>
          {coverFile ? `📕 ${coverFile.name.slice(0, 20)}` : '📷 표지 사진 선택'}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => setCoverFile(e.target.files?.[0] || null)}
          />
        </label>
        <button className="btn-ghost" style={{ marginTop: 0, flexShrink: 0 }} onClick={identifyCover} disabled={!coverFile || identifying}>
          {identifying ? '인식 중...' : '✨ 자동 인식'}
        </button>
      </div>
      <label className="label">책 제목</label>
      <input className="field en" placeholder="예: Should I Share My Ice Cream?" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
      <label className="label">저자</label>
      <input className="field en" placeholder="예: Mo Willems" value={meta.author} onChange={(e) => setMeta({ ...meta, author: e.target.value })} />
      <label className="label">시리즈</label>
      <input className="field en" placeholder="예: Elephant & Piggie" value={meta.series} onChange={(e) => setMeta({ ...meta, series: e.target.value })} />

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
