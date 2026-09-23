-- 기존 운영 프로젝트용: Supabase SQL Editor에서 한 번 실행하세요.
-- 여러 번 실행해도 안전합니다.

alter table public.books
  add column if not exists reading_guidance text not null default '';

-- PostgREST 스키마 캐시를 즉시 새로고침합니다.
notify pgrst, 'reload schema';

-- 실행 확인: reading_guidance_ok가 true이면 정상입니다.
select exists (
  select 1
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'books'
    and column_name = 'reading_guidance'
) as reading_guidance_ok;
