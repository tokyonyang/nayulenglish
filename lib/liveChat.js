'use client';

import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import { z } from 'zod';

/** Extracts the spoken/transcribed text from a Realtime API history item —
 *  the field name varies by content type, so this tries the documented
 *  possibilities rather than assuming one. */
export function extractHistoryText(item) {
  const parts = Array.isArray(item?.content) ? item.content : [];
  return parts.map((c) => c?.transcript || c?.text || '').join(' ').trim();
}

/** Starts a live (OpenAI Realtime API) voice conversation for Stage 2/3.
 *  Unlike the turn-based mode (record → wait → reply → speak), this keeps
 *  one open WebRTC connection: she can talk and be answered with much
 *  lower latency, and even interrupt the AI mid-sentence like a real
 *  conversation.
 *
 *  To keep working with the EXISTING report/CSV pipeline unchanged, each
 *  assistant turn calls a "log_turn" tool with the exact same shape as
 *  the turn-based mode's log entries (see lib/report.js's tally()) —
 *  onLog receives one of those per turn, so the caller can push it into
 *  the same stage.current[n].log array either mode already uses.
 *
 *  NOTE: this talks to the Realtime API's official JS SDK. A couple of
 *  details here (the exact shape of a transcript item in `history`, and
 *  where `voice` belongs in the session config) are this build's best
 *  reading of OpenAI's current docs rather than something verified by
 *  actually running a session — they're isolated in extractText() and
 *  the /api/realtime-session route below so they're easy to correct
 *  after a first real test.
 */
export async function startLiveSession({
  instructions,
  voice = 'coral',
  onHistory,   // (items) => void — raw history, for rendering chat bubbles
  onLog,       // (entry) => void — one per assistant turn, same shape as the turn-based log
  onWrapUp,    // () => void
  onError,     // (err) => void
}) {
  let lastChildText = '';

  const logTurn = tool({
    name: 'log_turn',
    description:
      "Call this silently immediately after every one of your spoken responses — it's for tracking her learning progress in the background. Never mention this tool or its fields to her.",
    parameters: z.object({
      childUtteranceType: z.enum(['word', 'phrase', 'simple_sentence', 'extended_sentence', 'korean', 'none'])
        .describe("Her MOST RECENT utterance, the one you're responding to right now."),
      childSupportLevel: z.enum(['spontaneous', 'prompted', 'modeled']).nullable(),
      questionType: z.enum(['who', 'what', 'where', 'why', 'feeling', 'other']).nullable()
        .describe('The kind of question in the response you just gave, or null if you did not ask one.'),
      expansionGiven: z.boolean().describe('True if you just expanded her word/phrase into a full sentence.'),
      invitedRepeat: z.boolean().describe('True if you just invited her to repeat a full sentence.'),
      koreanAssistUsed: z.boolean(),
      newVocabIntroduced: z.array(z.string()),
      vocabUsedByChild: z.array(z.string()),
      sceneRef: z.number().nullable().describe('The book spread/page number you are talking about right now, if any.'),
      wantsWrapUp: z.boolean().describe('True once this feels like a natural point to wrap up (roughly 5 minutes in, or 2-3 scenes covered).'),
    }),
    execute: async (args) => {
      onLog?.({ ...args, childText: lastChildText });
      if (args.wantsWrapUp) onWrapUp?.();
      return 'ok';
    },
  });

  const agent = new RealtimeAgent({
    name: 'nayul-reading-buddy',
    instructions,
    tools: [logTurn],
  });

  const res = await fetch('/api/realtime-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions, voice }),
  });
  if (!res.ok) throw new Error(await res.text());
  const { value: apiKey } = await res.json();
  if (!apiKey) throw new Error('실시간 세션 토큰을 받지 못했습니다.');

  const session = new RealtimeSession(agent, { model: 'gpt-realtime-mini' });

  session.on('history_updated', (history) => {
    onHistory?.(history);
    const lastUser = [...history].reverse().find((it) => it.type === 'message' && it.role === 'user' && it.status === 'completed');
    const text = lastUser ? extractHistoryText(lastUser) : '';
    if (text) lastChildText = text;
  });
  session.on('error', (e) => onError?.(e));

  await session.connect({ apiKey });
  return session;
}
