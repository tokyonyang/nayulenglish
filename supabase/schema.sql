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
