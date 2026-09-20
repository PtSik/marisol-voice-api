-- Stage 2 of retiring the `trial` shop status: remove the value itself.
--
-- ORDER MATTERS. Apply 0020 and deploy the worker that no longer accepts `trial` on
-- `POST/PATCH /admin/shops` before this runs. Applied against an older deployment, an admin write
-- of `status: 'trial'` stops being a validation error and becomes a 23514 from Postgres.
--
-- The rollback is `0015`'s constraint: re-adding the value is a one-line CHECK swap, and no data
-- is dropped here, so nothing is lost by going back.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shops WHERE status = 'trial') THEN
    RAISE EXCEPTION 'shops.status = trial still has rows; resolve them before contracting the CHECK';
  END IF;
END $$;

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_status_check;

ALTER TABLE shops
  ADD CONSTRAINT shops_status_check
  CHECK (status IN ('active', 'cancelled', 'suspended', 'demo'));
