-- Calendar routing lives next to the shop, not inside the encrypted credentials blob: the
-- blob keeps only the refresh_token, so the OAuth callback and the picker never write the
-- same field and cannot race. NULL means "one calendar, today's behaviour".
ALTER TABLE shops ADD COLUMN IF NOT EXISTS calendar_routing JSONB;

-- gcal_calendar_id is recorded per booking because rebuilding it from the staff name breaks
-- once the mapping changes after the booking was made.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS gcal_calendar_id TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_via TEXT,
  ADD COLUMN IF NOT EXISTS gcal_sync_pending BOOLEAN NOT NULL DEFAULT FALSE;
