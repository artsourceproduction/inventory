// create-admin
// Deployed as a Supabase Edge Function (Dashboard > Edge Functions > Deploy
// a new function > Via Editor). Paste this whole file in as the code.
//
// Why this has to be a server-side function at all: creating a new login
// with a specific email + password (rather than that person signing
// themselves up) requires Supabase's admin API, which only works with the
// service_role key. That key must never reach the browser - so this
// function holds it (as a Supabase-managed secret, never in this file,
// never in git) and the app calls this function instead of the admin API
// directly. The function itself re-checks the caller is the owner before
// doing anything, so only the Owner can ever use it, from the app UI.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const { email, password } = await req.json();

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required.' }), { status: 400, headers: corsHeaders });
    }

    // Client scoped to the CALLER's own token - used only to verify who
    // is asking, never to perform the privileged action itself.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Not logged in.' }), { status: 401, headers: corsHeaders });
    }

    const { data: profile } = await callerClient.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || profile.role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Only the owner can add admins.' }), { status: 403, headers: corsHeaders });
    }

    // Privileged client - service_role key only lives here, as a secret
    // set via the Dashboard/CLI, never in this source file.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: corsHeaders });
    }

    const { error: profileErr } = await adminClient.from('profiles').insert({
      id: created.user.id, email, role: 'admin', must_change_password: true,
    });
    if (profileErr) {
      return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, id: created.user.id }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unexpected error.' }), { status: 500, headers: corsHeaders });
  }
});
