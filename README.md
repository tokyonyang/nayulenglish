# 나율이의 영어책방 (v2.0)  

만 48개월 나율이를 위한 영어 읽어주기 + 스피킹 연습 앱.
"나율이 영어 스피킹 프로그램 Master Prompt v2.0" 스펙을 그대로 구현했습니다.

Next.js (App Router) · Vercel · Supabase · OpenAI

---

## 하루 흐름

1. **Stage 1 — 전체 책 읽어주기**
   펼침면 순서대로, 장면의 감정 톤에 맞춰 읽어줍니다. 퀴즈 없이 끝까지.
   자동으로 넘어가지 않고 "다음 펼침면" 버튼으로 진행합니다(실제 책장을 함께 넘기기 위해).
2. **Stage 2 — 책 관련 스피킹 (약 5분)**
   스피킹 가치가 높은 장면 2~3개를 다시 펼쳐 대화합니다. 퀴즈가 아니라 대화체.
3. **Stage 3 — 나율이 오늘 이야기 (약 5분)**
   책의 감정·행동에서 자연스럽게 이어 하루 이야기를 나눕니다.
4. **Daily Report**
   자발/힌트/모델링 발화를 자동 집계하고, 한국어 코멘트를 붙여 저장합니다. CSV로 내려받아 엑셀에 쌓을 수 있습니다.

핵심 규칙(단어 응답을 완전한 문장으로 확장해 되돌려주기, 세션당 2~4회만 따라 말하기 유도,
막힐 때 5단계 스캐폴딩, "틀렸어"라고 말하지 않기, Day 1~7 주제 순환)은
`lib/prompts.js` 에 모두 들어 있습니다. 문구를 바꾸고 싶으면 이 파일만 고치면 됩니다.

---

## 배포 (로컬 개발 환경 없이)

### 1. Supabase
1. 새 프로젝트를 만듭니다.
2. SQL Editor 에 `supabase/schema.sql` 내용을 붙여넣고 실행합니다.
3. Settings → API 에서 **Project URL** 과 **anon public key** 를 복사해둡니다.

### 2. Vercel
1. 이 저장소를 Vercel 에 Import 합니다.
2. Environment Variables 에 아래 3개를 넣습니다.

| 이름 | 값 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |

3. Deploy 를 누릅니다. 끝입니다.

이후 GitHub 웹에서 파일을 수정하면 Vercel 이 자동 재배포합니다.

---

## 사용하는 모델

| 용도 | 모델 | 위치 |
| --- | --- | --- |
| 책 사진 → 문장 추출 | `gpt-4.1-mini` (vision) | `app/api/scan` |
| 책 전체 정리(제목·톤·어휘) | `gpt-4.1-mini` | `app/api/enrich` |
| Stage 2·3 대화 | `gpt-4.1-mini` | `app/api/chat` |
| 리포트 코멘트 | `gpt-4.1-mini` | `app/api/report` |
| 읽어주기·대화 음성 | `gpt-4o-mini-tts` | `app/api/tts` |
| 나율이 음성 받아쓰기 | `whisper-1` | `app/api/stt` |

음성은 `lib/prompts.js` 의 `ttsInstructions()` 에서 장면 감정별 지시문으로 조절합니다.
"천천히 읽기"를 켜면 지시문에 느린 속도와 구절 사이 쉼이 추가됩니다.

---

## 책 등록하는 두 가지 방법

- **사진**: 펼침면을 순서대로 찍어 한 번에 올리면 문장·장면·감정 톤·핵심 어휘를 자동으로 뽑습니다.
  아이폰 사진은 브라우저에서 JPG로 변환·축소해서 업로드합니다.
- **문장 입력**: 책 문장을 순서대로 붙여넣고 펼침면 사이만 빈 줄 한 칸으로 구분하면 됩니다.
  나머지(제목·톤·장면 설명·어휘)는 AI가 채웁니다.

두 방법 모두 확인 화면에서 문장을 직접 고치고 펼침면을 추가할 수 있습니다.

---

## 알아둘 점

- 개인용이라 로그인이 없고, Supabase RLS 는 anon 전체 허용으로 열려 있습니다.
  다른 사람과 함께 쓰려면 `supabase/schema.sql` 의 정책을 auth 기반으로 바꾸세요.
- Day 수는 그 책의 리포트에 기록된 서로 다른 날짜 수로 계산합니다(최대 7).
  하루를 건너뛰어도 순서가 밀리지 않고, 같은 날 다시 해도 Day 가 중복 증가하지 않습니다.
- 마이크는 HTTPS 에서만 동작합니다(Vercel 배포본은 해당 없음).
