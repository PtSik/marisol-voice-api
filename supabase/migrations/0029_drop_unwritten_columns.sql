-- Three columns no code has ever written. Measured before writing this migration:
--   bookings.confirmation_code   0 of 27 rows set. Appears once in the whole codebase — in the
--                                TypeScript row type — and is never read or assigned. Confirmation
--                                codes live in `verification_codes`, hashed and single-use.
--   calls.transcript_url         0 of 98 rows set, and absent from the row type entirely.
--   calls.recording_url          0 of 98 rows set, and absent from the row type entirely.
--
-- Apply after the deploy that drops `confirmation_code` from the row type. The other two were
-- never referenced by any worker, so no deployment depends on them.
--
-- Rollback re-adds three nullable TEXT columns; there are no values to bring back.

ALTER TABLE public.bookings DROP COLUMN IF EXISTS confirmation_code;
ALTER TABLE public.calls DROP COLUMN IF EXISTS transcript_url;
ALTER TABLE public.calls DROP COLUMN IF EXISTS recording_url;
