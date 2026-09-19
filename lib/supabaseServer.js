import { createClient } from '@supabase/supabase-js';

let client;

/** Server-only Supabase client. A secret/service-role key is required so
 *  media metadata stays private and cache restoration does not depend on
 *  broad anonymous UPDATE policies. */
export function getServerSupabase() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SECRET_KEY 환경변수가 필요합니다.');
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
