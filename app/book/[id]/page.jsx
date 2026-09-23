'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseReady } from '@/lib/supabase';
import { DAY_THEMES, stage2Instructions, stage3Instructions, stage2LiveInstructions, stage3LiveInstructions } from '@/lib/prompts';
import {
  speakLines, stopSpeaking, spreadLines, chatLines, TTS_VOICES, precacheSpreads, checkCacheStatus,
  recordingSupported, startRecording, stopRecordingAndTranscribe, stopRecordingAsWav,
  listenUntilSilence, forceStopListening, cancelListening, primeAudio,
  spreadPhotoUrl, spreadPhotoFallbackUrl, backupBookToDrive,
} from '@/lib/audio';
import {
  tally, bestLevelLabel, pairStats, transcriptSummary, truncateMiddle, todayStr,
} from '@/lib/report';
import { startLiveSession, extractHistoryText } from '@/lib/liveChat';

const emptyStage = () => ({ turns: [], log: [], startedAt: 0, endedAt: 0 });

// From every previous day's saved transcript for this book, pull out every
// distinct line the AI has already said — not just questions, since a
// repeated OPENING comment ("That was fun! Let's look at that page
// again.") was slipping through a question-only filter — so today's
// conversation can be told not to repeat any of them. Deduped, capped so
// the prompt stays small.
function extractPriorQuestions(reports) {
  const seen = new Set();
  const qs = [];
  for (const r of reports || []) {
    for (const turn of r.transcript || []) {
      if (turn.role !== 'assistant') continue;
      const text = String(turn.content || '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      qs.push(text);
    }
  }
  return qs.slice(-30);
}

// Free Dictionary API (dictionaryapi.dev), proxied through /api/vocab — no
// OpenAI cost. Looks up a short definition + native pronunciation clip for
// one of the book's key vocabulary words.
function VocabWord({ word }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/vocab?word=${encodeURIComponent(word)}`)
      .then((res) => res.json())
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [word]);

  return (
    <div className="vocab-word">
      <div className="vocab-word-head">
        <span className="en vocab-term">{word}</span>
        {info?.phonetic && <span className="vocab-phonetic">{info.phonetic}</span>}
        {info?.audio && (
          <button className="btn-icon vocab-play" onClick={() => new Audio(info.audio).play().catch(() => {})}>
            🔊
          </button>
        )}
      </div>
      {info?.definition && <div className="vocab-def">{info.definition}</div>}
    </div>
  );
}

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
      slow: false, muted: false, cacheable: false, voice: v,
    });
  }

  const [precaching, setPrecaching] = useState('');
  async function precacheThisBook() {
    if (!book || precaching) return;
    setPrecaching(`읽어주기 음성 준비 중... (0/${book.spreads.length})`);
    try {
      await precacheSpreads(book.spreads, {
        bookId: book.id,
        voice,
        characterVoices: book.character_voices || {},
        onProgress: (done, total) => setPrecaching(`읽어주기 음성 준비 중... (${done}/${total})`),
      });
    } finally {
      setPrecaching('');
    }
  }

  const [cacheStatus, setCacheStatus] = useState('');
  async function checkCache() {
    if (!book || precaching) return;
    setCacheStatus('확인 중...');
    const { cached, total } = await checkCacheStatus(book.spreads, {
      bookId: book.id,
      voice,
      characterVoices: book.character_voices || {},
    });
    setCacheStatus(`${cached} / ${total}줄 캐시됨`);
  }

  // Automatic, non-blocking: as soon as a book is open, quietly fill in
  // whatever read-aloud audio is missing — already-cached lines are just
  // existence-checked (fast) and skipped, so a book that's fully ready
  // shows nothing here. Re-runs if the voice changes, so switching voices
  // also gets prepared ahead of time. Never blocks reading — readSpreadAt
  // does its own check-then-generate per line regardless.
  const [autoPrep, setAutoPrep] = useState('');
  const autoPrepBusy = useRef(false);
  useEffect(() => {
    if (!book || autoPrepBusy.current) return;
    autoPrepBusy.current = true;
    precacheSpreads(book.spreads, {
      bookId: book.id,
      voice,
      characterVoices: book.character_voices || {},
      onProgress: (done, total) => setAutoPrep(done < total ? `🎧 음성 준비 중... (${done}/${total})` : ''),
    }).finally(() => {
      autoPrepBusy.current = false;
      setAutoPrep('');
    });
  }, [book, voice]);

  const [backingUp, setBackingUp] = useState('');
  async function backupToDrive() {
    if (!book || backingUp) return;
    setBackingUp('Google Drive 백업 준비 중...');
    try {
      const { uploaded, updated, failed, total } = await backupBookToDrive(book, {
        voice,
        characterVoices: book.character_voices || {},
        onProgress: (done, totalCount, label) => setBackingUp(`백업 중... (${done}/${totalCount}) ${label || ''}`),
      });
      setBackingUp(
        total === 0
          ? '백업할 파일이 없어요 (사진·음성이 아직 준비되지 않았어요).'
          : `완료 — 새 원본 ${uploaded}개, 기존 원본 갱신 ${updated}개${failed ? `, 실패 ${failed}개` : ''}`
      );
    } catch (e) {
      setBackingUp(`백업 실패: ${String(e.message || e).slice(0, 150)}`);
    }
  }

  const [spreadIndex, setSpreadIndex] = useState(0);
  const [reading, setReading] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('nayul_autoplay') === '1') setAutoPlay(true);
  }, []);

  function toggleAutoPlay() {
    setAutoPlay((v) => {
      const next = !v;
      localStorage.setItem('nayul_autoplay', next ? '1' : '0');
      if (!next) stopSpeaking();
      return next;
    });
  }

  const [stageNum, setStageNum] = useState(2);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [listening, setListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [wrapUp, setWrapUp] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pauseStartRef = useRef(0);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Live (Realtime API) mode — an alternative to the turn-based mic flow.
  // Chosen once before a stage starts; the session itself lives outside
  // React state in a ref since it's an imperative WebRTC connection, not
  // render-driven data.
  const [liveMode, setLiveMode] = useState(false);
  const [liveStatus, setLiveStatus] = useState(''); // '' | 'connecting' | 'live'
  const [liveSceneRef, setLiveSceneRef] = useState(null);
  const liveSessionRef = useRef(null);

  function disconnectLive() {
    if (liveSessionRef.current) {
      try { liveSessionRef.current.close?.(); } catch (e) { console.error('live session close failed', e); }
      liveSessionRef.current = null;
    }
    setLiveStatus('');
    setLiveSceneRef(null);
  }

  function togglePause() {
    if (liveMode) {
      const next = !paused;
      try { liveSessionRef.current?.mute?.(next); } catch (e) { console.error('live mute failed', e); }
      if (next) pauseStartRef.current = Date.now();
      else {
        const pausedMs = Date.now() - pauseStartRef.current;
        const st = stage.current[stageNum];
        if (st.startedAt) st.startedAt += pausedMs;
      }
      setPaused(next);
      return;
    }
    if (paused) {
      // Resume — shift this stage's start time forward by however long we
      // were paused, so the session-duration stats in the final report
      // don't count the pause as speaking/listening time.
      const pausedMs = Date.now() - pauseStartRef.current;
      const st = stage.current[stageNum];
      if (st.startedAt) st.startedAt += pausedMs;
      setPaused(false);
    } else {
      stopSpeaking();
      if (listening) cancelListening();
      pauseStartRef.current = Date.now();
      setPaused(true);
    }
  }

  const [report, setReport] = useState(null);

  const stage = useRef({ 2: emptyStage(), 3: emptyStage() });
  const bottom = useRef(null);
  const priorQuestionsRef = useRef([]);

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      if (!supabaseReady) { setError('Supabase 환경변수가 설정되지 않았습니다.'); setScreen('error'); return; }
      const { data: b, error: e1 } = await supabase.from('books').select('*').eq('id', id).single();
      if (e1 || !b) { setError(e1?.message || '책을 찾지 못했어요.'); setScreen('error'); return; }
      const { data: reports } = await supabase
        .from('reports')
        .select('date, transcript, day, word_spont, phrase_spont, sent_spont, hint_sent, model_sent')
        .eq('book_id', id);
      const dates = new Set((reports || []).map((r) => r.date));
      const priorDays = dates.has(todayStr()) ? dates.size - 1 : dates.size;
      let nextDay = Math.min(Math.max(priorDays + 1, 1), 7);

      // Not a fixed, exam-style schedule — if the most recent session needed
      // heavy scaffolding (hints/modeled sentences) far more than she
      // answered on her own, repeat that same day's theme instead of
      // mechanically advancing, so the level actually follows her, not the
      // calendar.
      const lastReport = [...(reports || [])].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (lastReport && Number(lastReport.day) < 7) {
        const spont = (lastReport.word_spont || 0) + (lastReport.phrase_spont || 0) + (lastReport.sent_spont || 0);
        const struggled = (lastReport.hint_sent || 0) + (lastReport.model_sent || 0);
        const total = spont + struggled;
        if (total >= 3 && struggled / total > 0.6) nextDay = Number(lastReport.day);
      }

      setDay(nextDay);
      priorQuestionsRef.current = extractPriorQuestions(reports);
      setBook(b);
      setScreen('stage1');
    })();
    return () => stopSpeaking();
  }, [id]);

  /* ---------- timer ---------- */
  useEffect(() => {
    if (screen !== 'chat') return;
    const t = setInterval(() => {
      if (pausedRef.current) return; // freeze the displayed time while paused
      const st = stage.current[stageNum];
      if (st.startedAt) setElapsed(Math.floor((Date.now() - st.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [screen, stageNum]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  /* ---------- stage 1 ---------- */
  const autoPlayRef = useRef(false);
  const autoPlayBusy = useRef(false);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);

  async function readSpreadAt(i) {
    const s = book.spreads[i];
    if (!s) return;
    setReading(true);
    const lines = spreadLines(s, book.character_voices || {});
    const hasContent = lines.some((l) => l.text && l.text.trim());
    if (!hasContent) {
      // No text on this page at all — hold a beat of silence instead of
      // instantly skipping, so there's still time to look at the picture.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      await speakLines(lines, {
        slow, muted, cacheable: true, voice, bookId: book.id,
      });
    }
    setReading(false);
  }

  function goTo(i) {
    stopSpeaking();
    if (autoPlay) toggleAutoPlay(); // manual navigation takes over from auto-play
    setSpreadIndex(Math.max(0, Math.min(book.spreads.length - 1, i)));
  }

  // Auto-play: reads the current page, pauses a beat, then turns to the
  // next one on its own. Stops itself at the last page. A ref-guarded lock
  // (rather than relying on the `reading` state, which can lag a render
  // behind an awaited step) keeps this from double-firing on itself.
  useEffect(() => {
    if (screen !== 'stage1' || !autoPlay || !book || autoPlayBusy.current) return;
    if (spreadIndex >= book.spreads.length) return;
    autoPlayBusy.current = true;
    (async () => {
      await readSpreadAt(spreadIndex);
      if (!autoPlayRef.current) { autoPlayBusy.current = false; return; }
      if (spreadIndex >= book.spreads.length - 1) {
        autoPlayBusy.current = false;
        toggleAutoPlay();
        return;
      }
      await new Promise((r) => setTimeout(r, 900)); // a beat to look at the page before it turns
      autoPlayBusy.current = false;
      if (autoPlayRef.current) setSpreadIndex((i) => Math.min(book.spreads.length - 1, i + 1));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, spreadIndex, screen, book]);

  /* ---------- stage 2 / 3 ---------- */
  const askClaude = useCallback(async (n, instructions, turns, opts = {}) => {
    setThinking(true);
    let speak = null;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions, turns, audio: opts.audio }),
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      speak = String(d.speak || '').trim() || '...';
      const st = stage.current[n];

      // Text turns are already pushed into `turns` by the caller before this
      // runs. Audio turns aren't — we only learn what she said once the
      // model transcribes it, so we add her bubble here, right before ours.
      let childText = opts.childText ?? null;
      if (opts.audio) {
        childText = String(d.childTranscript || '').trim() || '(음성을 알아듣지 못했어요)';
        st.turns.push({ role: 'user', content: childText });
        setMessages((m) => [...m, { role: 'child', text: childText }]);
      }

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
        childText,
      });

      setMessages((m) => [...m, { role: 'assistant', text: speak, sceneRef: typeof d.sceneRef === 'number' ? d.sceneRef : null }]);
      if (d.wantsWrapUp) setWrapUp(true);
    } catch (e) {
      setMessages((m) => [...m, { role: 'system', text: `문제가 생겼어요: ${String(e.message || e).slice(0, 120)}` }]);
    } finally {
      setThinking(false);
    }

    // Keep the mic/input/send locked through actual playback, not just the
    // network round trip — otherwise a fast next turn can start (and begin
    // its own speakLines call) while this reply is still talking, and two
    // <audio> elements end up playing over each other.
    if (speak && !pausedRef.current) {
      setSpeaking(true);
      try {
        await speakLines(chatLines(speak), { slow, muted, voice });
      } finally {
        setSpeaking(false);
      }
    }
  }, [slow, muted, voice]);

  function instructionsFor(n) {
    if (n === 2) {
      return liveMode
        ? stage2LiveInstructions(book, day, priorQuestionsRef.current)
        : stage2Instructions(book, day, priorQuestionsRef.current);
    }
    const log2 = stage.current[2].log;
    let bridge = null;
    for (let i = log2.length - 1; i >= 0; i--) {
      if (log2[i].sceneRef != null) {
        bridge = book.spreads.find((s) => s.number === log2[i].sceneRef) || null;
        break;
      }
    }
    return liveMode
      ? stage3LiveInstructions(book, day, bridge, priorQuestionsRef.current)
      : stage3Instructions(book, day, bridge, priorQuestionsRef.current);
  }

  async function startStage(n) {
    primeAudio(); // fire from this real tap so iOS lets the listening context latch on
    stopSpeaking();
    const st = emptyStage();
    st.startedAt = Date.now();
    stage.current[n] = st;
    setStageNum(n);
    setMessages([]);
    setWrapUp(false);
    setElapsed(0);
    setPaused(false);
    setScreen('chat');

    if (liveMode) {
      setLiveStatus('connecting');
      try {
        const session = await startLiveSession({
          instructions: instructionsFor(n),
          voice,
          onHistory: (history) => {
            const items = history
              .filter((it) => it.type === 'message' && (it.role === 'user' || it.role === 'assistant') && it.status === 'completed')
              .map((it) => ({ role: it.role, text: extractHistoryText(it) }))
              .filter((b) => b.text);
            // Keep turns in the same shape the turn-based mode uses, so
            // the report's qualitative summary and next-day repeat-avoidance
            // both work identically regardless of which mode a day used.
            stage.current[n].turns = [
              { role: 'user', content: '(시작해주세요)' },
              ...items.map((b) => ({ role: b.role, content: b.text })),
            ];
            setMessages(items.map((b) => ({ role: b.role === 'user' ? 'child' : 'assistant', text: b.text })));
          },
          onLog: (entry) => {
            stage.current[n].log.push(entry);
            if (entry.sceneRef != null) setLiveSceneRef(entry.sceneRef);
          },
          onWrapUp: () => setWrapUp(true),
          onError: (e) => {
            console.error('live session error', e);
            setMessages((m) => [...m, { role: 'system', text: '라이브 연결에 문제가 생겼어요.' }]);
          },
        });
        liveSessionRef.current = session;
        setLiveStatus('live');
      } catch (e) {
        setLiveStatus('');
        setMessages((m) => [...m, { role: 'system', text: `라이브 모드 연결 실패: ${String(e.message || e).slice(0, 150)}` }]);
      }
      return;
    }

    await askClaude(n, instructionsFor(n), [{ role: 'user', content: '(시작해주세요)' }], {});
  }

  async function send(text) {
    const t = (text ?? input).trim();
    if (!t || thinking || speaking) return;
    if (listening) cancelListening(); // typing instead — abandon the open mic so it doesn't also fire
    const st = stage.current[stageNum];
    st.turns.push({ role: 'user', content: t });
    setMessages((m) => [...m, { role: 'child', text: t }]);
    setInput('');
    stopSpeaking();
    await askClaude(stageNum, instructionsFor(stageNum), st.turns, { childText: t });
  }

  async function sendAudio(base64Wav) {
    if (thinking || speaking) return;
    stopSpeaking();
    const st = stage.current[stageNum];
    // turns does NOT yet include this turn — askClaude adds her transcribed
    // bubble once the model hears the audio and tells us what she said.
    await askClaude(stageNum, instructionsFor(stageNum), st.turns, {
      audio: { data: base64Wav, format: 'wav' },
    });
  }

  async function toggleMic(lang) {
    primeAudio(); // a direct tap — good moment for iOS to let the listening context latch on
    if (lang === 'en' && listening) {
      // Already auto-listening — a tap means "I'm done, send it now"
      // instead of waiting for silence to be detected on its own.
      forceStopListening();
      return;
    }
    if (lang === 'ko' && listening) {
      // Switching to the Korean fallback mid-listen — abandon the EN
      // auto-listen without sending anything from it.
      cancelListening();
    }
    if (recording) {
      setRecording(false);
      try {
        if (lang === 'en') {
          const base64Wav = await stopRecordingAsWav();
          if (base64Wav) await sendAudio(base64Wav);
        } else {
          const text = await stopRecordingAndTranscribe(lang);
          if (text.trim()) await send(text.trim());
        }
      } catch (e) {
        console.error('mic flow failed', e);
        setMessages((m) => [...m, { role: 'system', text: '음성을 처리하지 못했어요. 직접 입력해주세요.' }]);
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

  // Hands-free: once it's her turn (nothing thinking, nobody talking, no
  // recording already in flight) the mic opens on its own. It stops itself
  // once she's said something and then gone quiet, and sends automatically
  // — no tap needed for either end. Tapping 🎤EN while this is running just
  // finishes it early; tapping 🎤KO abandons it in favor of the Korean
  // fallback. Silence with nothing said just tries again on its own.
  const autoListenBusy = useRef(false);
  useEffect(() => {
    if (screen !== 'chat' || stageNum === undefined) return;
    if (thinking || speaking || recording || listening || wrapUp || paused) return;
    if (!recordingSupported()) return;
    autoListenBusy.current = true;
    setListening(true);
    listenUntilSilence({ onLevel: setMicLevel })
      .then(async (result) => {
        setListening(false);
        autoListenBusy.current = false;
        if (result?.rejected) {
          // Pitch says this sounds like an adult, not a young child — skip
          // it and quietly go back to listening rather than sending it on.
          setMessages((m) => [...m, { role: 'system', text: '🎤 어른 목소리로 들려서 건너뛰었어요. 나율이가 다시 말해볼까요?' }]);
          return;
        }
        if (result?.audio) await sendAudio(result.audio);
      })
      .catch((e) => {
        console.error('auto-listen failed', e);
        setListening(false);
        autoListenBusy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, thinking, speaking, recording, listening, wrapUp, paused, messages]);

  /* ---------- report ---------- */
  async function finish() {
    disconnectLive();
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
    const cur = book.spreads[spreadIndex];
    const isFirst = spreadIndex === 0;
    const isLast = spreadIndex === book.spreads.length - 1;
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

        {book.character_voices && Object.keys(book.character_voices).length > 0 && (
          <p className="hint" style={{ margin: '6px 0 0' }}>
            🎭 {Object.entries(book.character_voices).map(([name, v]) => `${name}(${v})`).join(', ')}는 내레이션과 다른 고정 목소리로 나와요.
          </p>
        )}

        {autoPrep && <p className="hint" style={{ margin: '6px 0 0', textAlign: 'center' }}>{autoPrep}</p>}

        {precaching ? (
          <div className="banner info">{precaching}</div>
        ) : (
          <div className="row">
            <button className="btn-ghost" onClick={precacheThisBook}>
              ⚡ 이 책 읽어주기 음성 미리 준비하기
            </button>
            <button className="btn-ghost" onClick={checkCache}>
              📊 캐시 상태 확인
            </button>
          </div>
        )}
        {cacheStatus && !precaching && (
          <p className="hint" style={{ margin: '4px 0 0', textAlign: 'center' }}>{cacheStatus}</p>
        )}

        {backingUp ? (
          <div className="banner info">{backingUp}</div>
        ) : (
          <button className="btn-ghost" onClick={backupToDrive}>
            ☁️ Drive 원본 동기화
          </button>
        )}

        <div className="dots">
          {book.spreads.map((s, i) => (
            <button
              key={s.number}
              className={`dot ${i === spreadIndex ? 'now' : ''}`}
              style={{ padding: 0, border: 'none' }}
              aria-label={`펼침면 ${s.number}로 이동`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>

        <div className="stage-card">
          {(() => {
            const photoUrl = spreadPhotoUrl(book.id, cur.number);
            return photoUrl ? (
              <img
                src={photoUrl}
                alt=""
                className="stage-photo"
                onError={(e) => {
                  if (e.currentTarget.dataset.fallbackTried) {
                    e.currentTarget.style.display = 'none';
                    return;
                  }
                  const fallback = spreadPhotoFallbackUrl(book.id, cur.number);
                  if (fallback) {
                    e.currentTarget.dataset.fallbackTried = '1';
                    e.currentTarget.src = fallback;
                  } else {
                    e.currentTarget.style.display = 'none';
                  }
                }}
              />
            ) : null;
          })()}
          <div className="stage-num">펼침면 {cur.number} / {book.spreads.length}</div>
          <div className="stage-text">
            {Array.isArray(cur.dialogue) && cur.dialogue.length ? (
              cur.dialogue.map((d, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  {d.speaker && d.speaker !== 'Narrator' && (
                    <span style={{ fontWeight: 700, color: 'var(--accent)', marginRight: 6 }}>{d.speaker}:</span>
                  )}
                  <span>{d.text}</span>
                </div>
              ))
            ) : (
              cur.englishText || '(텍스트 없음)'
            )}
          </div>
          {cur.sceneDescription && <div className="spread-scene">{cur.sceneDescription}</div>}
        </div>

        <div className="row">
          <button className="btn-ghost" onClick={() => goTo(spreadIndex - 1)} disabled={isFirst}>◀ 이전 페이지</button>
          <button className="btn-ghost" onClick={() => goTo(spreadIndex + 1)} disabled={isLast}>다음 페이지 ▶</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn-ghost" onClick={() => readSpreadAt(spreadIndex)} disabled={reading}>
            {reading ? '🔊 읽는 중...' : '🔊 이 페이지 읽어주기'}
          </button>
          <button className="btn-ghost" onClick={() => setSlow((s) => !s)}>{slow ? '🐢 천천히 (켜짐)' : '🐢 천천히 읽기'}</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn-ghost" onClick={toggleAutoPlay}>
            {autoPlay ? '⏸ 자동 재생 (켜짐)' : '▶️ 자동으로 끝까지 읽기'}
          </button>
        </div>

        <label className="row" style={{ alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} />
          <span className="hint" style={{ margin: 0 }}>🎙️ 라이브 모드로 대화하기 (실시간 음성, 실험적 기능)</span>
        </label>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => startStage(2)}>이야기 시작하기 →</button>
      </>
    );
  }

  if (screen === 'chat') {
    const theme = DAY_THEMES[day];
    return (
      <>
        <div className="topbar">
          <Link href="/"><button className="btn-icon" onClick={() => { disconnectLive(); if (listening) cancelListening(); stopSpeaking(); }}>←</button></Link>
          <span className="title">{stageNum === 2 ? '📖 책 이야기' : '🌞 오늘 이야기'}</span>
          <div className="hgroup">
            <button className="btn-icon" onClick={togglePause}>{paused ? '▶' : '⏸'}</button>
            <button className="btn-icon" onClick={() => { setMuted((m) => !m); stopSpeaking(); }}>{muted ? '🔇' : '🔊'}</button>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-soft)', fontSize: 14 }}>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
          </div>
        </div>

        {stageNum === 2 && <p className="hint">오늘의 주제 · Day {day} “{theme.label}”</p>}

        <div className="transcript">
          {messages.map((m, i) => {
            const showScene = m.role === 'assistant' && stageNum === 2 && m.sceneRef;
            const photoUrl = showScene ? spreadPhotoUrl(book.id, m.sceneRef) : null;
            return (
              <div key={i}>
                {photoUrl && (
                  <img
                    src={photoUrl}
                    alt=""
                    style={{ maxWidth: '85%', display: 'block', borderRadius: 12, margin: '10px 0 4px' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div className={`bubble ${m.role}`}>{m.text}</div>
              </div>
            );
          })}
          {thinking && <div className="bubble system">🤔 생각하고 있어요...</div>}
          {speaking && <div className="bubble system">🔊 말하는 중...</div>}
          <div ref={bottom} />
        </div>

        {paused && (
          <div className="banner info" style={{ textAlign: 'center' }}>
            ⏸ 일시정지됨 — ▶ 버튼을 눌러 계속하기
          </div>
        )}
        {wrapUp && <div className="banner info">슬슬 마무리할 시간이에요 🌙</div>}

        {liveMode ? (
          <>
            {liveStatus === 'connecting' && <div className="banner info" style={{ textAlign: 'center' }}>🎙️ 라이브로 연결하고 있어요...</div>}
            {liveStatus === 'live' && !paused && (
              <div className="banner info" style={{ textAlign: 'center' }}>🔴 라이브 대화 중 — 편하게 말을 걸어보세요</div>
            )}
            {stageNum === 2 && liveSceneRef && (() => {
              const photoUrl = spreadPhotoUrl(book.id, liveSceneRef);
              return photoUrl ? (
                <img
                  src={photoUrl}
                  alt=""
                  style={{ maxWidth: '85%', display: 'block', margin: '0 auto 10px', borderRadius: 12 }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : null;
            })()}
            <button className="btn-ghost" onClick={togglePause} style={{ marginBottom: 8 }} disabled={liveStatus !== 'live'}>
              {paused ? '▶ 계속하기' : '⏸ 일시정지'}
            </button>
          </>
        ) : (
          <>
            {listening && (
              <div className="banner info" style={{ textAlign: 'center' }}>
                🎤 듣고 있어요... <span style={{ opacity: 0.4 + micLevel * 0.6 }}>●</span>
              </div>
            )}

            <button className="btn-ghost" onClick={togglePause} style={{ marginBottom: 8 }}>
              {paused ? '▶ 계속하기' : '⏸ 일시정지'}
            </button>

            <div className="inputbar">
              {recordingSupported() && (
                <>
                  <button
                    className={`mic ${recording || listening ? 'rec' : ''}`}
                    onClick={() => toggleMic('en')}
                    disabled={thinking || speaking || paused}
                  >
                    {recording || listening ? '■' : '🎤EN'}
                  </button>
                  <button className="mic" onClick={() => toggleMic('ko')} disabled={thinking || speaking || paused}>🎤KO</button>
                </>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder="나율이가 말한 내용을 입력해요"
                disabled={thinking || speaking || paused}
              />
              <button className="send" onClick={() => send()} disabled={thinking || speaking || paused}>보내기</button>
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn-ghost"
            disabled={liveMode || thinking || speaking || paused}
            onClick={() => {
              const last = [...messages].reverse().find((m) => m.role === 'assistant');
              if (!last) return;
              if (listening) cancelListening();
              stopSpeaking();
              setSpeaking(true);
              speakLines(chatLines(last.text), { slow, muted, voice }).finally(() => setSpeaking(false));
            }}
          >
            🔊 다시 듣기
          </button>
          {stageNum === 2 ? (
            <button
              className="btn"
              disabled={thinking || speaking || paused}
              onClick={() => { disconnectLive(); if (listening) cancelListening(); stage.current[2].endedAt = Date.now(); startStage(3); }}
            >
              다음: 오늘 이야기 →
            </button>
          ) : (
            <button
              className="btn"
              disabled={thinking || speaking || paused}
              onClick={() => { disconnectLive(); if (listening) cancelListening(); finish(); }}
            >
              세션 마무리 →
            </button>
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

      {book && (
        <>
          <h2>이 책의 핵심 표현</h2>
          {Array.isArray(book.overall_vocab) && book.overall_vocab.length > 0 ? (
            <div className="vocab-list">
              {book.overall_vocab.map((w) => <VocabWord key={w} word={w} />)}
            </div>
          ) : (
            <div className="banner info" style={{ marginBottom: 18 }}>
              아직 이 책의 핵심 표현이 준비되지 않았어요.{' '}
              <Link href={`/book/${id}/edit`} style={{ textDecoration: 'underline' }}>책 편집에서 다시 정리하기 →</Link>
            </div>
          )}
        </>
      )}
      <Link href="/history"><button className="btn-ghost">📋 지난 리포트 · CSV 내려받기</button></Link>
      <button className="btn" style={{ marginTop: 12 }} onClick={() => router.push('/')}>홈으로</button>
    </>
  );
}
