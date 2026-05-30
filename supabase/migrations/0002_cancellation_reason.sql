-- 0002_cancellation_reason.sql
-- Dedicated column for cancellation reason so it no longer overwrites bookings.notes.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
