-- Stage 1 of the pre-launch schema contraction (see 0024). Compatibility only: nothing is
-- removed here, so a deployed worker from before this migration keeps working unchanged.
--
-- `audit_log.actor` is NOT NULL with no default, so the code that stops supplying it cannot ship
-- until the column fills itself in. Every one of the 7125 existing rows is already 'system' —
-- the two writers in lib/calendar-alerts.ts hardcode it — so the default records the same value
-- the callers were passing.
--
-- `callbacks.status` needs no companion change: it already defaults to 'pending'.

ALTER TABLE audit_log ALTER COLUMN actor SET DEFAULT 'system';
