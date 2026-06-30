// Admin Operations Edge Function
// Runs with service_role key — safe from client-side exposure
// Verifies caller is authenticated developer before any action

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',  // service_role — only available server-side
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function verifyDeveloper(sessionUsername: string, sessionToken: string): Promise<boolean> {
  if (!sessionUsername || !sessionToken) return false;
  // Verify token matches stored session (prevent impersonation)
  const { data } = await supabase
    .from('app_sessions')
    .select('username')
    .eq('username', sessionUsername)
    .eq('token', sessionToken)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!data) return false;
  // Check role
  const { data: user } = await supabase
    .from('app_users')
    .select('role')
    .eq('username', sessionUsername)
    .maybeSingle();
  return user?.role === 'developer';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json() as {
      action: string;
      session_username: string;
      session_token: string;
      payload?: Record<string, unknown>;
    };

    const { action, session_username, session_token, payload } = body;

    // Gate: semua action harus dari developer terverifikasi
    const isAuthorized = await verifyDeveloper(session_username, session_token);
    if (!isAuthorized) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // ── Create User ──────────────────────────────────────
    if (action === 'create_user') {
      const { username, password, role = 'user', initial_credits = 0, package_label = '' } = payload ?? {};

      // Batasi role yang bisa dibuat
      if (!['user', 'member'].includes(role as string)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Role tidak diizinkan' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }

      const { data, error } = await supabase.rpc('admin_create_user', {
        p_username: username,
        p_password: password,
        p_role: role,
      });

      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── Delete User ──────────────────────────────────────
    if (action === 'delete_user') {
      const { username } = payload ?? {};
      const { data, error } = await supabase.rpc('delete_app_user', { p_username: username });
      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Unknown action' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
