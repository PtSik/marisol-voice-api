-- Stage 3 of the pre-launch schema contraction. Eight columns and one index that no code reads
-- to make a decision. Apply this ONLY after the compatible code (the commit that adds 0022) is
-- deployed and no older worker can still reach the database — a pre-0022 worker supplies
-- `audit_log.actor` and `callbacks.status` explicitly and will fail against this schema.
--
-- Rollback: re-adding a column does not bring its values back. Nothing here holds a value worth
-- recovering — measured at the time of writing:
--   callbacks.status / resolved_at   table is empty (0 rows)
--   audit_log.actor                  7125 rows, all 'system'
--   audit_log.target_type / target_id 7125 rows, all NULL — never written
--   shops.trial_ends_at / cancelled_at 14 rows, all NULL — never written
--   accounts.role                    6 rows, all 'owner'
-- To roll back to a pre-0022 worker, restore the columns with their original defaults first.
--
-- Deliberately kept: the callback record itself, cancellation provenance
-- (`cancellation_reason`, `cancelled_via`), `calendar_access_granted_at`, SMS opt-out
-- provenance and the referral payout history.

-- Redundant once `status` goes, but named so the removal is visible in review.
DROP INDEX IF EXISTS callbacks_shop_status;

-- The callback is a "call this person back" note. It was never worked through a status ladder:
-- escalate.ts inserts one and deletes it if the owner SMS fails, and nothing ever resolved one.
ALTER TABLE callbacks  DROP COLUMN IF EXISTS status;
ALTER TABLE callbacks  DROP COLUMN IF EXISTS resolved_at;

-- audit_log is the Discord alert feed, not a general audit trail: its only writers are the two
-- calendar-failure loggers and its only reader selects shop_id, action and payload. "Who did it"
-- is always the system, and the target was never recorded at all.
ALTER TABLE audit_log  DROP COLUMN IF EXISTS actor;
ALTER TABLE audit_log  DROP COLUMN IF EXISTS target_type;
ALTER TABLE audit_log  DROP COLUMN IF EXISTS target_id;

-- Both are leftovers of the self-serve trial that 0020 and 0021 retired. Neither was ever set.
ALTER TABLE shops      DROP COLUMN IF EXISTS trial_ends_at;
ALTER TABLE shops      DROP COLUMN IF EXISTS cancelled_at;

-- Shipped with the portal accounts table in 0007 to tell an owner from an employee. No account
-- creation path ever set it and no code in either repo compared it.
ALTER TABLE accounts   DROP COLUMN IF EXISTS role;
