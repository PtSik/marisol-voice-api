-- Enable Row-Level Security on every public table.
--
-- None of these tables ever had RLS enabled, which means the anon/authenticated
-- Postgres roles have Supabase's default table grants and the `public` schema is
-- exposed via PostgREST (see supabase/config.toml `[api] schemas`). Any caller
-- holding the project's anon key could read/write shops, bookings, accounts
-- (password hashes), verification_codes (booking OTP hashes), etc.
--
-- The API (apps/api/src/lib/supabase.ts) only ever talks to Supabase with the
-- service_role key, which bypasses RLS entirely (BYPASSRLS). No policies are
-- needed for the app to keep working — enabling RLS with zero policies simply
-- makes every table default-deny for anon/authenticated, closing the hole
-- without touching application behaviour.

ALTER TABLE shops                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE callbacks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync_state  ENABLE ROW LEVEL SECURITY;
