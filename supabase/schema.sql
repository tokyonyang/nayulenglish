-- 나율이 영어 스피킹 프로그램 v2.0 — Supabase schema
-- Supabase 대시보드 > SQL Editor 에 그대로 붙여넣고 실행하세요.

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  themes text default '',
  overall_vocab jsonb not null default '[]'::jsonb,
  spreads jsonb not null default '[]'::jsonb,
  sessions_count int not null default 0,
  last_session_date date,
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references books(id) on delete cascade,
  book_title text,
  date date not null,
  day int not null default 1,

  total_minutes int default 0,
  stage2_minutes int default 0,
  stage3_minutes int default 0,

  word_spont int default 0,
  phrase_spont int default 0,
  sent_spont int default 0,
  hint_sent int default 0,
  model_sent int default 0,
  best_level text default '-',

  new_vocab text default '',
  spont_vocab text default '',
  why_understanding text default '0/0',
  other_understanding text default '0/0',
  expansions int default 0,

  engagement text default '',
  best_quote text default '',
  difficulty text default '',
  next_goal text default '',
  comment text default '',

  transcript jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reports_book_date_idx on reports (book_id, date desc);

alter table books enable row level security;
alter table reports enable row level security;

-- 개인용 앱이라 anon 키로 전체 접근을 허용합니다.
-- 여러 사람이 쓰게 되면 auth 기반 정책으로 바꾸세요.
drop policy if exists "books all access" on books;
create policy "books all access" on books for all using (true) with check (true);

drop policy if exists "reports all access" on reports;
create policy "reports all access" on reports for all using (true) with check (true);

-- ── 책 읽어주기(Stage 1) 음성 캐시 ──────────────────────────────
-- 같은 책은 7일 동안 매일 같은 문장을 읽어주므로, 문장+톤별로 한 번만
-- 합성하고 mp3를 저장해뒀다가 재생만 하도록 합니다. (OpenAI TTS 비용 절감)
insert into storage.buckets (id, name, public)
values ('tts-cache', 'tts-cache', true)
on conflict (id) do nothing;

drop policy if exists "tts-cache public read" on storage.objects;
create policy "tts-cache public read"
  on storage.objects for select
  using (bucket_id = 'tts-cache');

drop policy if exists "tts-cache public write" on storage.objects;
create policy "tts-cache public write"
  on storage.objects for insert
  with check (bucket_id = 'tts-cache');

-- ── 책 펼침면 사진 ──────────────────────────────
-- Stage 1에서 텍스트와 함께 실제 사진을 보여주기 위해 저장합니다.
-- 경로 규칙: {book id}/{spread number}.jpg
insert into storage.buckets (id, name, public)
values ('book-photos', 'book-photos', true)
on conflict (id) do nothing;

drop policy if exists "book-photos public read" on storage.objects;
create policy "book-photos public read"
  on storage.objects for select
  using (bucket_id = 'book-photos');

drop policy if exists "book-photos public write" on storage.objects;
create policy "book-photos public write"
  on storage.objects for insert
  with check (bucket_id = 'book-photos');

-- ── 등장인물별 고정 목소리 ──────────────────────────────
-- {"Gerald": "onyx", "Piggie": "shimmer"} 같은 형태로, 한 번 배정된
-- 등장인물의 목소리는 이후 다시 정리해도 유지됩니다.
alter table books add column if not exists character_voices jsonb not null default '{}'::jsonb;

-- ── Google Drive 원본 + Supabase 임시 캐시 ─────────────────────
-- Drive 파일은 원본, Storage 객체는 지워져도 다시 채울 수 있는 캐시입니다.
alter table books add column if not exists drive_book_folder_id text;
alter table books add column if not exists drive_photos_folder_id text;
alter table books add column if not exists drive_audio_folder_id text;

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  bucket text not null check (bucket in ('book-photos', 'tts-cache')),
  object_path text not null,
  drive_file_id text not null,
  drive_folder_id text,
  mime_type text,
  byte_size bigint,
  sha256 text,
  cache_status text not null default 'cached' check (cache_status in ('cached', 'missing')),
  last_cache_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, bucket, object_path)
);

create index if not exists media_assets_drive_file_idx on media_assets (drive_file_id);
alter table media_assets enable row level security;

-- media_assets에는 Drive 식별자가 들어가므로 브라우저에는 공개하지 않습니다.
-- 서버의 Supabase secret/service-role 키만 RLS를 우회해 접근합니다.
revoke all on table media_assets from anon, authenticated;

-- 새 저장은 서버 API를 거치므로 익명 Storage 쓰기는 더 이상 필요하지 않습니다.
drop policy if exists "tts-cache public write" on storage.objects;
drop policy if exists "book-photos public write" on storage.objects;

-- ── 등장인물 목소리를 책 전체(전 세계)에 걸쳐 공유 ──────────────────────────
-- Elephant & Piggie 같은 시리즈는 같은 인물이 여러 책에 등장합니다. 예전에는
-- 책마다 따로 배정해서 같은 인물이 책마다 다른 목소리로 나올 수 있었습니다.
-- character_key는 정규화(소문자·trim)한 이름이라 "Gerald"/"gerald"도 같은
-- 항목으로 취급됩니다. books.character_voices는 캐시로 계속 남겨두되,
-- 새로 배정할 때는 여기를 먼저 찾아보고, 없으면 새로 만들어 여기 저장합니다.
create table if not exists character_voices (
  character_key text primary key,
  display_name text not null,
  voice text not null,
  created_at timestamptz not null default now()
);
alter table character_voices enable row level security;
drop policy if exists "character_voices all access" on character_voices;
create policy "character_voices all access" on character_voices for all using (true) with check (true);

-- ── 저자·시리즈 — AI가 실제 배경지식을 활용해 더 실감나게 읽도록 ──────────
-- 유명한 책/시리즈면(예: Mo Willems의 Elephant & Piggie) AI가 이미 등장인물
-- 성격, 특유의 어조를 알고 있는 경우가 많습니다. 스캔한 텍스트만으로는 이걸
-- 못 살리므로, 제목 외에 저자·시리즈를 따로 저장해 정리(enrich) 단계에서
-- 참고하게 합니다.
alter table books add column if not exists author text default '';
alter table books add column if not exists series text default '';
