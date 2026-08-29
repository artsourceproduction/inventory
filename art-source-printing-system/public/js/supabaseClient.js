// supabaseClient.js
// Phase Foundation 3: initializes the Supabase client the whole app uses.
// Anon key only - safe to expose in browser code by design. No
// service_role key here or anywhere in frontend code.
const SUPABASE_URL = 'https://cmorisybgmuxhcufnqsz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtb3Jpc3liZ211eGhjdWZucXN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NTE5NTMsImV4cCI6MjEwMzIyNzk1M30.h0bxmk-zf1Z3enGUl1Z0ii13RNdAq1wqK0l1rTx-s8k';

// The library itself exposes a global called `supabase` - naming our
// client the same causes "already declared". Use a different name and
// keep it on window so app.js can still reach it everywhere.
window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
