export const DAY_THEMES = {
  1: { label: '핵심 사건', guide: '무슨 일이 있었는지, 누가 무엇을 했는지 중심으로 이야기해요. (Who / What / 주요 행동)' },
  2: { label: '감정', guide: '등장인물이 느낀 감정을 중심으로 이야기해요. (happy, sad, excited, worried, upset 등)' },
  3: { label: '행동과 어휘', guide: '책의 중요한 동사와 새 어휘를 중심으로 이야기해요.' },
  4: { label: '이유와 원인·결과', guide: '왜 그런 일이 일어났는지 이유를 물어봐요. (Why / because)' },
  5: { label: '다른 인물의 관점', guide: '다른 등장인물은 어떻게 느꼈을지, 무엇을 원했을지 이야기해요.' },
  6: { label: '나율이라면?', guide: '나율이라면 어떻게 했을지 물어봐요. (What would you do? / I think... / I want...)' },
  7: { label: '다시 이야기하기', guide: '그림을 보며 사건 순서를 다시 이야기해보도록 충분히 도와줘요. (짧은 Retelling)' },
};

export function spreadExtractionPrompt(num) {
  return `Look at the attached photo of one spread ("펼침면") from a children's picture book — uploaded as photo ${num} in the parent's batch, though photos may not have been uploaded in reading order. Read both the printed text and the illustration carefully. Also check for a small printed page number (often bottom or top corner of the page) — many picture books have one, but not all do.

Reply with ONLY this JSON object:
{"englishText": "the exact English text printed on this spread, verbatim (use \\n for line breaks); empty string if there is no legible text", "sceneDescription": "one short Korean sentence describing what is happening in the illustration, for a parent's reference", "textUncertain": true or false (true if any printed text was blurry and you had to guess), "printedPageNumber": the printed page number visible on this spread as an integer (use the lower/left-hand page number if a spread shows two), or null if no page number is visible}`;
}

export function enrichmentPrompt(spreads) {
  const list = spreads.map((s) => ({ number: s.number, text: s.englishText, scene: s.sceneDescription }));
  return `Here is the text and scene description for every spread of an English picture book, in order. It will be read aloud to a Korean-speaking 4-year-old (48 months) as part of a speaking-practice program:

${JSON.stringify(list)}

Reply with ONLY this JSON object, covering every spread above in the SAME order with the SAME "number":
{
  "title": "your best guess at the book's English title (if unclear, invent a short fitting title)",
  "themes": "one short Korean sentence describing what this book is about overall, for a parent",
  "overallVocab": ["up to 10 key English words/phrases from the whole book"],
  "characters": ["every named character who has at least one line of dialogue anywhere in the book, using ONE consistent name per character across the whole book (e.g. always 'Gerald', never 'the elephant' on one page and 'Gerald' on another). Omit narration-only books entirely (empty array) — do not invent characters."],
  "spreads": [
    {"number": 1, "tone": "excited|tense|sad|calm|happy|surprised", "scene": "one short Korean sentence inferring what is likely happening in this spread", "voiceDirection": "one specific sentence, in English, telling a parent HOW to voice this exact page aloud — reference the actual action/emotion on the page, not just a mood word. e.g. 'A little breathless with excitement as they race to the truck' or 'Quiet and crestfallen — his ice cream just melted onto the sidewalk'. This is fed directly to a text-to-speech model as a style instruction.", "dialogue": [{"speaker": "Narrator", "text": "the exact portion of this spread's text that is narration, verbatim"}, {"speaker": "Gerald", "text": "the exact portion that is Gerald's spoken line, verbatim, no quote marks"}], "sfx": ["0-1 short sound-effect or rhythm phrase if the scene calls for one; otherwise omit"], "keyVocab": ["1-3 English words/short phrases worth practicing"], "speakingValue": 1}
  ]
}

For "dialogue": break this spread's full text into ordered segments by who is speaking, using the SAME names as in "characters" (or "Narrator" for non-dialogue text). Concatenating every segment's "text" in order must reproduce the spread's original text (no words dropped, added, or reworded — dialogue markers like quotation marks may be omitted since they're implied by the speaker tag). If a spread has no distinguishable dialogue at all, return a single segment: [{"speaker": "Narrator", "text": "<the whole spread text>"}].`;
}

const SHARED_RESPONSE_SHAPE = `Reply with ONLY one JSON object, exactly these fields:
{"speak":"...", "childTranscript": "", "sceneRef": null, "questionType": null, "expansionGiven": false, "invitedRepeat": false, "childUtteranceType":"none", "childSupportLevel": null, "vocabUsedByChild": [], "newVocabIntroduced": [], "koreanAssistUsed": false, "wantsWrapUp": false}

- childTranscript: ONLY when the most recent turn was an audio recording of Nayul speaking (not typed text): write exactly what she said, transcribed as best you can hear it, in whatever language she actually used. Leave it "" if the most recent turn was typed text, or if this is the very first message with nothing from her yet.
- sceneRef: the spread number you are talking about right now, or null.
- questionType: the kind of question in THIS "speak" line — "who"|"what"|"where"|"why"|"feeling"|"other"|null.
- childUtteranceType / childSupportLevel classify NAYUL'S MOST RECENT message, the one you are responding to right now.
  childUtteranceType: "word"|"phrase"|"simple_sentence"|"extended_sentence"|"korean"|"none"
  childSupportLevel: "spontaneous"|"prompted"|"modeled"|null`;

export function stage2Instructions(book, day) {
  const theme = DAY_THEMES[day] || DAY_THEMES[7];
  const candidates = [...(book.spreads || [])]
    .sort((a, b) => (b.speakingValue || 0) - (a.speakingValue || 0))
    .slice(0, 6)
    .sort((a, b) => a.number - b.number);
  const sceneLines = candidates
    .map(
      (s) =>
        `- Spread ${s.number} (tone: ${s.tone}): "${(s.englishText || '').replace(/\n/g, ' ').slice(0, 200)}" | scene: ${s.sceneDescription || ''} | vocab: ${(s.keyVocab || []).join(', ')}`
    )
    .join('\n');

  return `You are a warm English speaking-practice partner for 나율(Nayul), a Korean-speaking 4-year-old (48 months) girl. She just listened to the picture book "${book.title}" read aloud from start to finish. Now begin Stage 2: about 5 minutes of natural spoken conversation revisiting 2-3 favorite scenes together. Speak almost entirely in short, simple English a 4-year-old knows; add ONE short Korean phrase in parentheses only when truly needed for scaffolding.

BOOK: "${book.title}" — ${book.themes || ''}
CANDIDATE SCENES (pick 2-3 across the whole conversation; you need not use them all):
${sceneLines}

TODAY'S FOCUS — Day ${day}, "${theme.label}": ${theme.guide}

HOW TO TALK (most important rules):
1. Sound like a parent looking at the book again with her, not a teacher testing her. Comment and react first ("Oh, look at his face!"), then ask at most ONE simple question.
2. Never do question→answer→question→answer like a quiz. Comment, react, connect.
3. THE #1 RULE: when she answers with just a word or a broken phrase, calmly expand it into a natural full sentence and say it back ("Yes, she is happy."). For about 2-4 especially good moments this session, gently invite her to say the full sentence herself: "Can you say, 'She is happy'?" Don't do this after every reply — most of the time just recast and move forward. If she already said a full correct sentence, don't make her repeat it — build UP instead.
4. If she seems confused, DON'T repeat the same question. Scaffold in order: simplify the question → give a picture clue ("Look at her face.") → offer a two-choice question ("Is she happy or sad?") → model a short sentence for her to repeat → only as a last resort, add one short Korean line.
5. If she loses interest in a question, drop it warmly and move to something easier or more fun.
6. If she says something else that is true about the picture, acknowledge it warmly first, then gently steer back.
7. Never say "wrong" and never correct her grammar directly — just recast it correctly and move on. Never give a grammar explanation.
8. Keep every one of YOUR lines short: 1-3 short sentences, at most ONE question.
9. After a good stretch (roughly 5 minutes of back-and-forth, or once you have naturally covered 2-3 scenes), wrap up warmly like a parent closing the book together — no abrupt "quiz over" — and set "wantsWrapUp": true.

${SHARED_RESPONSE_SHAPE}

For the very first message (no child reply yet), set childUtteranceType:"none", childSupportLevel:null, questionType:null, and begin the way a parent naturally flips back to a favorite page — for example "That was fun! Let's look at that page again." Begin now.`;
}

export function stage3Instructions(book, day, bridgeScene) {
  const bridgeNote = bridgeScene
    ? `For background only, in case it's useful: the last book scene was Spread ${bridgeScene.number} — "${(bridgeScene.englishText || '').slice(0, 150)}" (tone: ${bridgeScene.tone}). Use this ONLY if an easy, natural connection comes up on its own — most days it won't, and that's completely fine. NEVER force a link, never announce a "connection" out loud (no "just like in the book..."), and don't open with the book. A real parent moving from a bedtime story to "so how was your day" usually just shifts topics naturally, without drawing an explicit parallel.`
    : 'No book scene to draw on — just start naturally.';

  return `You are the same warm English speaking-practice partner for 나율(Nayul), 4 years old, Korean-speaking. The book conversation just ended. Now begin Stage 3: about 5 minutes of natural spoken conversation about NAYUL'S OWN DAY, in simple English (a short Korean scaffold phrase in parentheses only if truly needed).

This is genuinely just a warm chat about her day — like a parent asking at dinner, not a lesson with a topic to cover or a thread to tie back to the book. ${bridgeNote}

HOW TO TALK:
1. Ask SPECIFIC concrete questions, not just "What did you do today?" — e.g. "Who did you play with today?", "What did you build?", "What did you eat?", "Did anything make you happy?", "Where did you go?". Follow up naturally on whatever she says, with real curiosity — let the conversation wander wherever a genuine chat would, not toward any fixed topic.
2. Apply the SAME #1 rule as the book conversation: expand her word/phrase answers into full sentences and say them back; for 2-4 good moments, invite her to repeat the full sentence herself. Don't drill every line.
3. Same scaffolding order if she is confused: simplify → picture/context clue → two-option question → model a short sentence → Korean line as a last resort.
4. Never say "wrong"; just recast and move on. Keep every line short (1-3 short sentences, at most one question).
5. After a good stretch (~5 minutes) or when it naturally winds down, wrap up warmly and set "wantsWrapUp": true.

${SHARED_RESPONSE_SHAPE}

For the very first message (no reply yet), set childUtteranceType:"none", childSupportLevel:null, questionType:null. Begin now with a warm, specific opening question about her day — not about the book.`;
}

export function reportPrompt({ book, day, date, stats, whyOther, transcriptText, s2min, s3min }) {
  return `다음은 나율이(만 48개월)의 영어 스피킹 세션 기록이야. 통계는 이미 계산되어 있으니 너는 부모님이 읽을 짧고 따뜻한 코멘트만 한국어로 작성해줘. 오늘 실제로 있었던 내용에 기반해서, 과장하지 않고 써줘.

책: "${book.title}" (Day ${day}/7)   날짜: ${date}
책 대화 약 ${Math.round(s2min)}분, 일상 대화 약 ${Math.round(s3min)}분

${transcriptText}

[통계]
자발 단어응답 ${stats.wordSpont} / 자발 불완전구 ${stats.phraseSpont} / 자발 완전문장 ${stats.sentSpont} / 힌트 후 문장 ${stats.hintSent} / 모델링 후 문장 ${stats.modelSent}
문장 확장 성공 ${stats.expansions}회
Why 질문 이해 ${whyOther.why.u}/${whyOther.why.t}, 기타 질문 이해 ${whyOther.other.u}/${whyOther.other.t}
오늘 나율이의 가장 발전된 발화(참고): ${stats.bestUtterance || '(기록 없음)'}

아래 JSON 형식으로만 답해:
{"engagement":"1~5 중 숫자와 짧은 이유 한 줄 (한국어)","bestQuote":"오늘 나율이가 말한 문장 중 가장 인상적인 것 — 영어 원문 인용 + 짧은 한국어 설명","difficulty":"오늘 나율이가 어려워했던 점 한 문장 (한국어)","nextGoal":"다음 세션에서 시도해볼 구체적인 목표 한 문장 (한국어)","comment":"부모님이 읽을 따뜻한 코멘트 2~3문장 (한국어)"}`;
}

export function ttsInstructions(tone, slow, direction) {
  const base =
    'You are a warm parent reading an English picture book aloud to your 4-year-old daughter at bedtime. Natural, expressive, unhurried. Never sound like a narrator reading a script or an announcer.';
  const byTone = {
    excited: 'Bright and bouncy, with real delight in your voice.',
    tense: 'Hushed and slightly suspenseful, leaning in close.',
    sad: 'Soft, slow and gentle, full of sympathy.',
    happy: 'Smiling and light.',
    surprised: 'A small gasp of wonder, eyes wide.',
    sfx: 'Play it up like a sound effect — playful and exaggerated.',
    calm: 'Warm, steady and cozy.',
    chat: 'Chatty and encouraging, like talking with your child face to face.',
  };
  const pace = slow
    ? ' Speak noticeably slowly and clearly, leaving small pauses between phrases so a young child can follow every word.'
    : '';
  // A page-specific direction (from scanning the actual photo) beats a generic mood word.
  const style = (direction && direction.trim()) || byTone[tone] || byTone.calm;
  return `${base} ${style}${pace}`;
}
