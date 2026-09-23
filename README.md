# 나율이의 영어책방 (v2.0)  

만 48개월 나율이를 위한 영어 읽어주기 + 스피킹 연습 앱.
"나율이 영어 스피킹 프로그램 Master Prompt v2.0" 스펙을 그대로 구현했습니다.

Next.js (App Router) · Vercel · Supabase · Google Drive · OpenAI

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
3. 이미 운영 중인 프로젝트라면 SQL Editor에서
   `supabase/migrations/20260919073855_drive_primary_media.sql`도 실행합니다.
4. Settings → API 에서 **Project URL**, **publishable/anon key**, **secret key**를 복사해둡니다.

### 2. Vercel
1. 이 저장소를 Vercel 에 Import 합니다.
2. Environment Variables 에 아래 값을 넣습니다.

| 이름 | 값 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |
| `SUPABASE_SECRET_KEY` | 서버 전용 Supabase secret key (`sb_secret_...`, 브라우저에 노출 금지) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth 클라이언트 ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth 클라이언트 보안 비밀번호 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Drive 접근용 장기 refresh token |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | 앱 원본을 보관할 Drive 폴더 ID |

3. Deploy 를 누릅니다. 끝입니다.

이후 GitHub 웹에서 파일을 수정하면 Vercel 이 자동 재배포합니다.

### 사진·음성 저장 방식

- **Google Drive가 원본 저장소**입니다. 새 사진과 읽어주기 음성은 Drive에 먼저 저장합니다.
- **Supabase Storage는 임시 캐시**입니다. 캐시가 있으면 빠르게 사용합니다.
- Supabase Storage에서 파일을 삭제해도, 다음 표시·재생 때 Drive 원본을 찾아 자동으로
  Supabase에 다시 채운 뒤 정상 사용합니다.
- 기존에 Supabase에만 있던 파일은 책 화면의 **Drive 원본 동기화** 버튼을 한 번 누르면
  Drive 원본과 `media_assets` 기록이 만들어집니다.
- `SUPABASE_SECRET_KEY`, Google OAuth 비밀값은 서버 Route Handler에서만 사용되며
  `NEXT_PUBLIC_` 접두사를 붙이면 안 됩니다.

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

책 정보의 **책 전체 읽기 안내**에는 책마다 원하는 말투·속도·유머·강조 방식을 자유롭게
적을 수 있습니다. 예: “웃긴 책입니다. 목소리 톤을 바꾸며 과장해서 재미있게 읽어주세요.”
이 안내는 모든 펼침면의 Stage 1 음성과 Stage 2 책 이야기 대화에 함께 적용됩니다.

두 방법 모두 확인 화면에서 문장을 직접 고치고 펼침면을 추가할 수 있습니다.

기존 운영 DB에는 배포 전에 Supabase SQL Editor에서
`supabase/add_reading_guidance.sql`을 한 번 실행하세요.

---

## 알아둘 점

- 개인용이라 책·리포트 테이블은 현재 anon 접근을 허용합니다. Drive 파일 ID를 담는
  `media_assets`는 RLS로 막고 서버 secret key만 접근합니다. 다른 사람과 함께 쓰려면
  책·리포트 정책도 Supabase Auth 기반으로 바꾸세요.
- Supabase Storage를 비울 때는 `book-photos`, `tts-cache`의 **객체만** 지우세요.
  `books`, `reports`, `media_assets` 테이블이나 Drive 원본은 지우면 자동 복원이 불가능합니다.
- Day 수는 그 책의 리포트에 기록된 서로 다른 날짜 수로 계산합니다(최대 7).
  하루를 건너뛰어도 순서가 밀리지 않고, 같은 날 다시 해도 Day 가 중복 증가하지 않습니다.
- 마이크는 HTTPS 에서만 동작합니다(Vercel 배포본은 해당 없음).
