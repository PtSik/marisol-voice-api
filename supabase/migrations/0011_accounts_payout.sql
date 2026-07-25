-- Cash-only referral rewards: the referrer claims the $200 and we send it by hand, so the
-- account carries the handle we send it to (paypal | venmo | zelle).
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS payout_method text,
  ADD COLUMN IF NOT EXISTS payout_handle text;
