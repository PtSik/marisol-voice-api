-- 0001_init.sql

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── shops ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shops (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            TEXT NOT NULL,
  twilio_number                   TEXT NOT NULL UNIQUE,
  escalation_phone                TEXT NOT NULL,
  owner_escalation_phone          TEXT NOT NULL,
  owner_email                     TEXT NOT NULL,
  timezone                        TEXT NOT NULL DEFAULT 'America/New_York',
  ai_disclosure_text              TEXT NOT NULL DEFAULT 'You are speaking with an AI assistant.',
  hours_json                      TEXT NOT NULL DEFAULT '{}',
  closures_json                   TEXT NOT NULL DEFAULT '[]',
  services_json                   TEXT NOT NULL DEFAULT '[]',
  staff_json                      TEXT NOT NULL DEFAULT '[]',
  integration                     TEXT NOT NULL DEFAULT 'none' CHECK (integration IN ('google_calendar', 'none')),
  integration_credentials_encrypted TEXT,
  status                          TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'cancelled', 'suspended')),
  trial_ends_at                   TIMESTAMPTZ,
  cancelled_at                    TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── bookings ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_phone    TEXT NOT NULL,
  customer_name     TEXT,
  staff             TEXT NOT NULL,
  service           TEXT,
  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ NOT NULL,
  time_range        tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  notes             TEXT,
  gcal_event_id     TEXT,
  idempotency_key   TEXT,
  confirmation_code TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  EXCLUDE USING gist (
    shop_id WITH =,
    staff WITH =,
    time_range WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency
  ON bookings (shop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_shop_status
  ON bookings (shop_id, status);

CREATE INDEX IF NOT EXISTS bookings_customer_phone
  ON bookings (customer_phone);

-- ─── callbacks ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS callbacks (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_phone              TEXT NOT NULL,
  reason                      TEXT,
  elevenlabs_conversation_id  TEXT,
  status                      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS callbacks_shop_status
  ON callbacks (shop_id, status, created_at DESC);

-- ─── verification_codes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verification_codes_booking
  ON verification_codes (booking_id)
  WHERE used_at IS NULL;

-- ─── calls ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  elevenlabs_conversation_id  TEXT NOT NULL UNIQUE,
  duration_seconds            INTEGER,
  outcome                     TEXT,
  transcript_url              TEXT,
  recording_url               TEXT,
  started_at                  TIMESTAMPTZ,
  ended_at                    TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calls_shop_created
  ON calls (shop_id, created_at DESC);

-- ─── audit_log ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID REFERENCES shops(id) ON DELETE SET NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_shop_created
  ON audit_log (shop_id, created_at DESC);
