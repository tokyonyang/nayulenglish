import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function projectRef(url) {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/** Safe deployment diagnostics. It deliberately returns only presence flags
 *  and the already-public Supabase project ref — never secret values. */
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  const supabasePublicConfigured = Boolean(
    supabaseUrl && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  );
  const supabaseServerConfigured = Boolean(
    process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );

  return NextResponse.json(
    {
      ok: openaiConfigured && supabasePublicConfigured && supabaseServerConfigured,
      openaiConfigured,
      supabasePublicConfigured,
      supabaseServerConfigured,
      supabaseProjectRef: projectRef(supabaseUrl),
      environment: process.env.VERCEL_ENV || 'local',
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}
