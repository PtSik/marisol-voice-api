-- Conversation language on bookings (drives SMS language, incl. reminders)
ALTER TABLE bookings ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'es'));

-- Pre-appointment reminder state (null = not sent yet)
ALTER TABLE bookings ADD COLUMN reminder_sent_at TIMESTAMPTZ;

-- Premium gate: reminders only for shops that pay for them
ALTER TABLE shops ADD COLUMN reminders_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX bookings_reminder_due ON bookings (start_at)
  WHERE status = 'confirmed' AND reminder_sent_at IS NULL;
