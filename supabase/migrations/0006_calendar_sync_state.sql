-- Incremental calendar→Supabase sync state: one Google syncToken per (shop, calendar).
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  sync_token  TEXT,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS bookings_gcal_pending ON bookings (updated_at) WHERE gcal_sync_pending;
