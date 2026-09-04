-- The sales demo pool is created with status='demo' (the landing repo's scripts/buy-demo-pool.ts),
-- a value the CHECK in 0001_init.sql never allowed. Any environment rebuilt from these migrations
-- rejects that insert with 23514, so the pool script cannot be re-run against a fresh database.
--
-- Recreated rather than added: production carries five such rows already, so its constraint was
-- altered out of band at some point. DROP ... IF EXISTS makes this the same statement whether the
-- database has the original constraint, the hand-altered one, or none.

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_status_check;

ALTER TABLE shops ADD CONSTRAINT shops_status_check
  CHECK (status IN ('trial', 'active', 'cancelled', 'suspended', 'demo'));
