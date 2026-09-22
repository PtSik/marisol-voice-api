-- Removes the five "Marisol Demo" pool shops. Each one was a fixed Supabase row paired with a
-- leased Twilio number in the landing repo's `demo_numbers` table; the sales flow that rewrote
-- them with a prospect's scraped name and hours is gone, and the numbers have been released in
-- Twilio, so the rows point at nothing.
--
-- This deletes data. What goes with it, measured before writing this migration:
--   bookings 0, callbacks 0, calendar_sync_state 0, audit_log 0, accounts 0, referrals 0
--   calls    7   ← cascades away with the shops; demo call records, no customer history
--
-- The demo lines that still serve the landing page — Barbarossa Barbershop (+18336596941) and
-- Pampered Paws Pet Grooming (+18788678115) — are NOT touched: they are is_demo shops with their
-- own numbers, matched here by name and status so neither can be caught by accident.

DELETE FROM shops
WHERE name = 'Marisol Demo'
  AND status = 'demo'
  AND is_demo = true;
