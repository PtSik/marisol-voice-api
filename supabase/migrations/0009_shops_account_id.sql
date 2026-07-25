-- 0009_shops_account_id.sql
-- Multiple salons per account: a shop belongs to the account that owns it. This is the only way
-- to say "these salons are the same person" — accounts.shop_id points at just the first one.
-- Backfill from accounts.shop_id so every existing single-salon account keeps its shop.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

UPDATE shops s
SET account_id = a.id
FROM accounts a
WHERE a.shop_id = s.id AND s.account_id IS NULL;

CREATE INDEX IF NOT EXISTS shops_account_id_idx ON shops (account_id);
