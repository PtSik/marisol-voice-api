-- Client portal accounts (Google Sign-In) and the referral ledger they earn against.
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  google_sub    TEXT UNIQUE,
  shop_id       UUID REFERENCES shops(id) ON DELETE SET NULL,
  lead_id       TEXT,
  referral_code TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS referrals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  referred_lead_id    TEXT NOT NULL UNIQUE,
  referred_shop_id    UUID REFERENCES shops(id) ON DELETE SET NULL,
  referred_email      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  amount_cents        INT NOT NULL DEFAULT 20000,
  payout_method       TEXT,
  payout_ref          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qualified_at        TIMESTAMPTZ,
  -- qualified_at + 30 days; no credit is booked before it, so a client who churns in
  -- week three never costs us the $200.
  mature_at           TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_account_id);
