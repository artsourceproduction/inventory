// remove-member
// Deploy via Supabase Dashboard > Edge Functions > Deploy a new function
// > Via Editor. Note the URL Supabase actually assigns it (may differ
// from the name you type - same issue as create-member) and use that
// exact URL in app.js's REMOVE_FUNCTION_URL.
//
// Deletes the auth account entirely. Because profiles.id references
// auth.users(id) ON DELETE CASCADE, this also removes their profiles
// row automatically - no separate delete needed. Works identically for
// revoking a not-yet-accepted invite (it's just an account with no
// password set yet) and removing an active account.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const { target_id } = await req.json();

    if (!target_id) {
      return new Response(JSON.stringify({ error: 'target_id is required.' }), { status: 400, headers: corsHeaders });
    }

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: 'Not logged in.' }), { status: 401, headers: corsHeaders });
    }

    if (target_id === caller.id) {
      return new Response(JSON.stringify({ error: 'You cannot remove your own account.' }), { status: 400, headers: corsHeaders });
    }

    const { data: callerProfile } = await callerClient.from('profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile) {
      return new Response(JSON.stringify({ error: 'Caller has no profile.' }), { status: 403, headers: corsHeaders });
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data: target } = await adminClient.from('profiles').select('role, managed_by').eq('id', target_id).single();
    if (!target) {
      return new Response(JSON.stringify({ error: 'Account not found.' }), { status: 404, headers: corsHeaders });
    }

    if (target.role === 'owner') {
      return new Response(JSON.stringify({ error: 'The Owner account cannot be removed.' }), { status: 403, headers: corsHeaders });
    }

    if (callerProfile.role === 'owner') {
      // may remove any Admin or User
    } else if (callerProfile.role === 'admin') {
      if (target.role !== 'user' || target.managed_by !== caller.id) {
        return new Response(JSON.stringify({ error: 'You can only remove Users you created.' }), { status: 403, headers: corsHeaders });
      }
    } else {
      return new Response(JSON.stringify({ error: 'Only the Owner or an Admin can remove accounts.' }), { status: 403, headers: corsHeaders });
    }

    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(target_id);
    if (deleteErr) {
      return new Response(JSON.stringify({ error: deleteErr.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unexpected error.' }), { status: 500, headers: corsHeaders });
  }
});
