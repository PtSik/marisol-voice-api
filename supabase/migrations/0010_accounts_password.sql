-- Email/password login for portal accounts, alongside the existing Google Sign-In.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
