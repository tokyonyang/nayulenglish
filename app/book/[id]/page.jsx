'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { DAY_THEMES, stage2Instructions, stage3Instructions } from '@/lib/prompts';
import {
  speakLines, stopSpeaking, spreadLines, chatLines, TTS_VOICES,
  recordingSupported, startRecording, stopRecordingAndTranscribe,
} from '@/lib/audio';
import {
  tally, bestLevelLabel, pairStats, transcriptSummary, truncateMiddle, todayStr,
} from '@/lib/report';

const emptyStage = () => ({ turns: [], log: [], startedAt: 0, endedAt: 0 });

export default function Session() {
  const { id } = useParams();
  const router = useRouter();

  const [book, setBook] = useState(null);
  const [day, setDay] = useState(1);
  const [screen, setScreen] = useState('loading');
  const [error, setError] = useState('');

  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
  const [voice, setVoice] = useState('coral');

  useEffect(() => {
    const saved = localStorage.getItem('nayul_voice');
    if (saved && TTS_VOICES.includes(saved)) setVoice(saved);
  }, []);

  function changeVoice(v) {
    setVoice(v);
    localStorage.setItem('nayul_voice', v);
  }

  function previewVoice(v) {
    stopSpeaking();
    speakLines([{ text: "Hi there! Let's read a book together.", tone: 'calm' }], {
      slow: false, muted: false, cacheable: true, voice: v,
    });
  }

  const [spreadIndex, setSpreadIndex] = useState(0);
  const [reading, setReading] = useState(false);

  const [stageNum, setStageNum] = useState(2);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [wrapUp, setWrapUp] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const [report, setReport] = useState(null);

  const stage = useRef({ 2: emptyStage(), 3: emptyStage() });
  const bottom = useRef(null);

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      if (!supabaseReady) { setError('Supabase 환경변수가 설정되지 않았습니다.'); setScreen('error'); return; }
      const { data: b, error: e1 } = await supabase.from('books').select('*').eq('id', id).single();
      if (e1 || !b) { setError(e1?.message || '책을 찾지 못했어요.'); setScreen('error'); return; }
      const { data: reports } = await supabase.from('reports').select('date').eq('book_id', id);
      const dates = new Set((reports || []).map((r) => r.date));
      const priorDays = dates.has(todayStr()) ? dates.size - 1 : dates.size;
      setDay(Math.min(Math.max(priorDays + 1, 1), 7));
      setBook(b);
      setScreen('stage1');
    })();
    return () => stopSpeaking();
  }, [id]);

  /* ---------- timer ---------- */
  useEffect(() => {
    if (screen !== 'chat') return;
    const t = setInterval(() => {
      const st = stage.current[stageNum];
      if (st.startedAt) setElapsed(Math.floor((Date.now() - st.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [screen, stageNum]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  /* ---------- stage 1 ---------- */
  async function readCurrent() {
    const s = book.spreads[spreadIndex];
    if (!s) return;
    setReading(true);
    await speakLines(
      [{ text: `Let's look at page ${s.number}.`, tone: 'calm' }, ...spreadLines(s)],
      { slow, muted, cacheable: true, voice }
    );
    setReading(false);
    setSpreadIndex((i) => i + 1);
  }

  async function replayLast() {
    const s = book.spreads[spreadIndex - 1];
    if (!s) return;
    setReading(true);
    await speakLines(spreadLines(s), { slow, muted, cacheable: true, voice });
    setReading(false);
  }

  /* ---------- stage 2 / 3 ---------- */
  const askClaude = useCallback(async (n, instructions, turns, childText) => {
    setThinking(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions, turns }),
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      const speak = String(d.speak || '').trim() || '...';

      const st = stage.current[n];
      st.turns.push({ role: 'assistant', content: speak });
      st.log.push({
        questionType: d.questionType || null,
        childUtteranceType: d.childUtteranceType || 'none',
        childSupportLevel: d.childSupportLevel || null,
        vocabUsedByChild: Array.isArray(d.vocabUsedByChild) ? d.vocabUsedByChild : [],
        newVocabIntroduced: Array.isArray(d.newVocabIntroduced) ? d.newVocabIntroduced : [],
        expansionGiven: !!d.expansionGiven,
        invitedRepeat: !!d.invitedRepeat,
        koreanAssistUsed: !!d.koreanAssistUsed,
        sceneRef: typeof d.sceneRef === 'number' ? d.sceneRef : null,
        childText: childText ?? null,
      });

      setMessages((m) => [...m, { role: 'assistant', text: speak }]);
      if (d.wantsWrapUp) setWrapUp(true);
      speakLines(chatLines(speak), { slow, muted, voice });
    } catch (e) {
      setMessages((m) => [...m, { role: 'system', text: `문제가 생겼어요: ${String(e.message || e).slice(0, 120)}` }]);
    } finally {
      setThinking(false);
    }
  }, [slow, muted, voice]);

  function instructionsFor(n) {
    if (n === 2) return stage2Instructions(book, day);
    const log2 = stage.current[2].log;
    let bridge = null;
    for (let i = log2.length - 1; i >= 0; i--) {
      if (log2[i].sceneRef != null) {
        bridge = book.spreads.find((s) => s.number === log2[i].sceneRef) || null;
        break;
      }
    }
    return stage3Instructions(book, day, bridge);
  }

  async function startStage(n) {
    stopSpeaking();
    const st = emptyStage();
    st.startedAt = Date.now();
    stage.current[n] = st;
    setStageNum(n);
    setMessages([]);
    setWrapUp(false);
    setElapsed(0);
    setScreen('chat');
    await askClaude(n, instructionsFor(n), [{ role: 'user', content: '(시작해주세요)' }], null);
  }

  async function send(text) {
    const t = (text ?? input).trim();
    if (!t || thinking) return;
    const st = stage.current[stageNum];
    st.turns.push({ role: 'user', content: t });
    setMessages((m) => [...m, { role: 'child', text: t }]);
    setInput('');
    stopSpeaking();
    await askClaude(stageNum, instructionsFor(stageNum), st.turns, t);
  }

  async function toggleMic(lang) {
    if (recording) {
      setRecording(false);
      try {
        const text = await stopRecordingAndTranscribe(lang);
        if (text.trim()) await send(text.trim());
      } catch (e) {
        setMessages((m) => [...m, { role: 'system', text: '음성을 알아듣지 못했어요. 직접 입력해주세요.' }]);
      }
    } else {
      try {
        stopSpeaking();
        await startRecording();
        setRecording(true);
      } catch {
        setMessages((m) => [...m, { role: 'system', text: '마이크를 사용할 수 없어요. 직접 입력해주세요.' }]);
      }
    }
  }

  /* ---------- report ---------- */
  async function finish() {
    stopSpeaking();
    stage.current[stageNum].endedAt = Date.now();
    setScreen('generating');

    const s2 = stage.current[2];
    const s3 = stage.current[3];
    const s2min = s2.endedAt && s2.startedAt ? (s2.endedAt - s2.startedAt) / 60000 : 0;
    const s3min = s3.endedAt && s3.startedAt ? (s3.endedAt - s3.startedAt) / 60000 : 0;

    const stats = tally([...s2.log, ...s3.log]);
    const p2 = pairStats(s2.log);
    const p3 = pairStats(s3.log);
    const whyOther = {
      why: { t: p2.why.t + p3.why.t, u: p2.why.u + p3.why.u },
      other: { t: p2.other.t + p3.other.t, u: p2.other.u + p3.other.u },
    };

    const transcriptText = truncateMiddle(
      `${transcriptSummary('책 이야기', s2.turns)}\n\n${transcriptSummary('오늘 이야기', s3.turns)}`,
      3000
    );

    let qual = { engagement: '-', bestQuote: stats.bestUtterance || '-', difficulty: '-', nextGoal: '-', comment: '' };
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book: { title: book.title }, day, date: todayStr(),
          stats: {
            wordSpont: stats.wordSpont, phraseSpont: stats.phraseSpont, sentSpont: stats.sentSpont,
            hintSent: stats.hintSent, modelSent: stats.modelSent,
            expansions: stats.expansions, bestUtterance: stats.bestUtterance,
          },
          whyOther, transcriptText, s2min, s3min,
        }),
      });
      if (res.ok) qual = { ...qual, ...(await res.json()) };
    } catch (e) { console.error(e); }

    const row = {
      book_id: book.id,
      book_title: book.title,
      date: todayStr(),
      day,
      total_minutes: Math.max(0, Math.round(s2min + s3min)),
      stage2_minutes: Math.max(0, Math.round(s2min)),
      stage3_minutes: Math.max(0, Math.round(s3min)),
      word_spont: stats.wordSpont,
      phrase_spont: stats.phraseSpont,
      sent_spont: stats.sentSpont,
      hint_sent: stats.hintSent,
      model_sent: stats.modelSent,
      best_level: bestLevelLabel(stats),
      new_vocab: [...stats.newVocab].join(', '),
      spont_vocab: [...stats.spontVocab].join(', '),
      why_understanding: `${whyOther.why.u}/${whyOther.why.t}`,
      other_understanding: `${whyOther.other.u}/${whyOther.other.t}`,
      expansions: stats.expansions,
      engagement: qual.engagement,
      best_quote: qual.bestQuote,
      difficulty: qual.difficulty,
      next_goal: qual.nextGoal,
      comment: qual.comment,
      transcript: [...s2.turns.slice(1), ...s3.turns.slice(1)],
    };

    const { data } = await supabase.from('reports').insert(row).select().single();
    await supabase
      .from('books')
      .update({ sessions_count: (book.sessions_count || 0) + 1, last_session_date: todayStr() })
      .eq('id', book.id);

    setReport(data || row);
    setScreen('report');
  }

  /* ---------- render ---------- */
  if (screen === 'loading') return <div className="center"><div className="spinner" /></div>;
  if (screen === 'error') return (
    <div className="center">
      <div className="banner">{error}</div>
      <Link href="/"><button className="btn">홈으로</button></Link>
    </div>
  );
  if (screen === 'generating') return (
    <div className="center"><div className="spinner" /><p className="hint">오늘 리포트를 만들고 있어요...</p></div>
  );

  if (screen === 'stage1') {
    const done = spreadIndex >= book.spreads.length;
    const current = book.spreads[Math.min(spreadIndex, book.spreads.length - 1)];
    const shown = spreadIndex === 0 ? null : book.spreads[spreadIndex - 1];
    return (
      <>
        <div className="topbar">
          <Link href="/"><button className="btn-icon">←</button></Link>
          <span className="title">📖 {book.title}</span>
          <div className="hgroup">
            <span className="btn-icon" style={{ width: 'auto', padding: '0 10px', fontSize: 12 }}>Day {day}</span>
            <button className="btn-icon" onClick={() => { setMuted((m) => !m); stopSpeaking(); }}>{muted ? '🔇' : '🔊'}</button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8 }}>
          <select
            className="field en"
            style={{ flex: 1, padding: '9px 10px', fontSize: 13.5 }}
            value={voice}
            onChange={(e) => changeVoice(e.target.value)}
          >
            {TTS_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <button className="btn-icon" style={{ width: 'auto', padding: '0 12px', fontSize: 12.5 }} onClick={() => previewVoice(voice)}>
            🔊 미리듣기
          </button>
        </div>

        <div className="dots">
          {book.spreads.map((s, i) => (
            <span key={s.number} className={`dot ${i < spreadIndex ? 'done' : ''} ${i === spreadIndex ? 'now' : ''}`} />
          ))}
        </div>

        <div className="stage-card">
          {shown ? (
            <>
              <div className="stage-num">펼침면 {shown.number}</div>
              <div className="stage-text">{shown.englishText || '(텍스트 없음)'}</div>
              {shown.sceneDescription && <div className="spread-scene">{shown.sceneDescription}</div>}
            </>
          ) : (
            <div className="hint" style={{ textAlign: 'center', margin: 0 }}>버튼을 눌러서 첫 펼침면을 시작해요 📖</div>
          )}
        </div>

        <div className="row">
          <button className="btn-ghost" onClick={replayLast} disabled={reading || spreadIndex === 0}>🔊 다시 듣기</button>
          <button className="btn-ghost" onClick={() => setSlow((s) => !s)}>{slow ? '🐢 천천히 (켜짐)' : '🐢 천천히 읽기'}</button>
        </div>

        {done ? (
          <button className="btn" style={{ marginTop: 14 }} onClick={() => startStage(2)}>책 다 읽었어요! 이야기 시작하기 →</button>
        ) : (
          <button className="btn" style={{ marginTop: 14 }} onClick={readCurrent} disabled={reading}>
            {reading ? '읽는 중...' : spreadIndex === 0 ? '펼침면 보기 ▶' : `다음 펼침면 ▶ (${current.number})`}
          </button>
        )}

        <button className="btn-text" style={{ display: 'block', margin: '16px auto 0' }} onClick={() => startStage(2)}>
          책 읽기 건너뛰고 대화하러 가기 →
        </button>
      </>
    );
  }

  if (screen === 'chat') {
    const theme = DAY_THEMES[day];
    return (
      <>
        <div className="topbar">
          <Link href="/"><button className="btn-icon" onClick={stopSpeaking}>←</button></Link>
          <span className="title">{stageNum === 2 ? '📖 책 이야기' : '🌞 오늘 이야기'}</span>
          <div className="hgroup">
            <button className="btn-icon" onClick={() => { setMuted((m) => !m); stopSpeaking(); }}>{muted ? '🔇' : '🔊'}</button>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-soft)', fontSize: 14 }}>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
          </div>
        </div>

        {stageNum === 2 && <p className="hint">오늘의 주제 · Day {day} “{theme.label}”</p>}

        <div className="transcript">
          {messages.map((m, i) => <div className={`bubble ${m.role}`} key={i}>{m.text}</div>)}
          {thinking && <div className="bubble system">🤔 생각하고 있어요...</div>}
          <div ref={bottom} />
        </div>

        {wrapUp && <div className="banner info">슬슬 마무리할 시간이에요 🌙</div>}

        <div className="inputbar">
          {recordingSupported() && (
            <>
              <button className={`mic ${recording ? 'rec' : ''}`} onClick={() => toggleMic('en')} disabled={thinking}>
                {recording ? '■' : '🎤EN'}
              </button>
              <button className="mic" onClick={() => toggleMic('ko')} disabled={thinking || recording}>🎤KO</button>
            </>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="나율이가 말한 내용을 입력해요"
            disabled={thinking}
          />
          <button className="send" onClick={() => send()} disabled={thinking}>보내기</button>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn-ghost" onClick={() => { const last = [...messages].reverse().find((m) => m.role === 'assistant'); if (last) speakLines(chatLines(last.text), { slow, muted, voice }); }}>
            🔊 다시 듣기
          </button>
          {stageNum === 2 ? (
            <button className="btn" onClick={() => { stage.current[2].endedAt = Date.now(); startStage(3); }}>
              다음: 오늘 이야기 →
            </button>
          ) : (
            <button className="btn" onClick={finish}>세션 마무리 →</button>
          )}
        </div>
      </>
    );
  }

  // report
  const r = report;
  const rows = [
    ['총 스피킹시간', `${r.total_minutes}분`],
    ['책 대화시간', `${r.stage2_minutes}분`],
    ['일상 대화시간', `${r.stage3_minutes}분`],
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
      <div className="topbar"><span className="title">🎉 오늘의 리포트</span></div>
      <div style={{ textAlign: 'center', padding: '18px 0 4px' }}>
        <div className="en" style={{ fontSize: 20, fontWeight: 700 }}>{r.book_title} · Day {r.day}</div>
        <div className="hint" style={{ margin: 4 }}>{r.date} · 총 {r.total_minutes}분</div>
      </div>
      <div className="report-grid">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <div className="report-k">{k}</div>
            <div>{v ?? '-'}</div>
          </div>
        ))}
      </div>
      {r.comment && <div className="report-comment">{r.comment}</div>}
      <Link href="/history"><button className="btn-ghost">📋 지난 리포트 · CSV 내려받기</button></Link>
      <button className="btn" style={{ marginTop: 12 }} onClick={() => router.push('/')}>홈으로</button>
    </>
  );
}
