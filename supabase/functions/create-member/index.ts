// create-member
// Deploy via Supabase Dashboard > Edge Functions > Deploy a new function
// > Via Editor. Name it exactly "create-member".
//
// Creates a login (via Supabase's built-in invite-by-email - no
// plaintext password ever generated or emailed by us) and a matching
// profiles row. Enforces the hierarchy server-side:
//   - Owner can create 'admin' or 'user' accounts.
//   - Admin can create 'user' accounts only, and only ever manages
//     the users they personally created.
// The service_role key lives only here (Supabase-managed secret),
// never in any frontend file.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const { email, role, redirectTo } = await req.json();

    if (!email || !role || !['admin', 'user'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Email and a valid role (admin or user) are required.' }), { status: 400, headers: corsHeaders });
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

    const { data: callerProfile } = await callerClient.from('profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile) {
      return new Response(JSON.stringify({ error: 'Caller has no profile.' }), { status: 403, headers: corsHeaders });
    }

    if (callerProfile.role === 'owner') {
      // may create admin or user - both allowed
    } else if (callerProfile.role === 'admin') {
      if (role !== 'user') {
        return new Response(JSON.stringify({ error: 'Admins can only create User accounts.' }), { status: 403, headers: corsHeaders });
      }
    } else {
      return new Response(JSON.stringify({ error: 'Only the Owner or an Admin can create accounts.' }), { status: 403, headers: corsHeaders });
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    );

    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo || undefined,
    });
    if (inviteErr) {
      return new Response(JSON.stringify({ error: inviteErr.message }), { status: 400, headers: corsHeaders });
    }

    // Admin-created users are tracked under that admin; Owner-created
    // admins have no manager (NULL); Owner-created users are tracked
    // under the Owner.
    const managedBy = role === 'admin' ? null : caller.id;

    const { error: profileErr } = await adminClient.from('profiles').insert({
      id: invited.user.id,
      email,
      role,
      managed_by: managedBy,
      must_change_password: true,
    });
    if (profileErr) {
      return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, id: invited.user.id }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unexpected error.' }), { status: 500, headers: corsHeaders });
  }
});
