-- Two things callers ask that the agent had no way to answer. From the call recordings: "Where are
-- you located?" and "Do you take walk-ins?" — both got "I don't have that in my system", and the
-- prompt actually listed the shop's address as a reason to escalate.
--
-- `address` is its own column rather than free text: it is asked constantly, and it has uses beyond
-- the agent (confirmation texts, invoices).
--
-- `notes` is the long tail — parking, walk-in policy, payment methods, anything the owner wants the
-- agent to know. The onboarding wizard has collected this field since day one (its placeholder reads
-- "Parking info, walk-in policy, a second language…") but it only ever reached the team's
-- notification email, never the shop row, so the agent never saw a word of it.
--
-- Both nullable with no default: metadata-only change, no table rewrite, existing rows untouched.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS notes TEXT;
