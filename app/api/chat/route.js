import { NextResponse } from 'next/server';
import { chatJSON, transcribe, withRetries } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { instructions, turns, audio } = await req.json();
    const messages = [{ role: 'system', content: instructions }, ...(turns || [])];

    let data;
    if (audio?.data) {
      try {
        data = await withRetries(() => chatJSON({ messages, maxTokens: 500, temperature: 0.8, audio }));
      } catch (e) {
        // The audio-hearing model is a preview and occasionally misbehaves
        // on structured JSON — fall back to the reliable Whisper+text path
        // rather than leaving the child mid-conversation with an error.
        console.error('audio chat failed, falling back to whisper+text', e);
        try {
          const buf = Buffer.from(audio.data, 'base64');
          const file = new File([buf], 'speech.wav', { type: 'audio/wav' });
          const text = (await transcribe({ file, language: 'en' })).trim();
          const fallbackMessages = [...messages, { role: 'user', content: text || '(...)' }];
          data = await withRetries(() => chatJSON({ messages: fallbackMessages, maxTokens: 500, temperature: 0.8 }));
          if (!data.childTranscript) data.childTranscript = text;
        } catch (e2) {
          // Both the direct-audio attempt AND the Whisper+text fallback
          // failed — rather than surfacing a raw API error into the
          // conversation, respond with a gentle, in-character line so the
          // session can just continue.
          console.error('whisper+text fallback also failed', e2);
          data = {
            speak: "Sorry, I didn't quite catch that — can you say it again?",
            childTranscript: '', sceneRef: null, questionType: null,
            expansionGiven: false, invitedRepeat: false,
            childUtteranceType: 'none', childSupportLevel: null,
            vocabUsedByChild: [], newVocabIntroduced: [], koreanAssistUsed: false, wantsWrapUp: false,
          };
        }
      }
    } else {
      data = await withRetries(() => chatJSON({ messages, maxTokens: 500, temperature: 0.8 }));
    }

    return NextResponse.json(data);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
