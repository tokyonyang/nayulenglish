alter table public.books add column if not exists drive_book_folder_id text;
alter table public.books add column if not exists drive_photos_folder_id text;
alter table public.books add column if not exists drive_audio_folder_id text;

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
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

create index if not exists media_assets_drive_file_idx
  on public.media_assets (drive_file_id);

alter table public.media_assets enable row level security;
revoke all on table public.media_assets from anon, authenticated;

drop policy if exists "tts-cache public write" on storage.objects;
drop policy if exists "book-photos public write" on storage.objects;
