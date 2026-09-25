-- Retires the `demo` shop status, the same way 0020/0021 retired `trial`.
--
-- It was a second spelling of `shops.is_demo`. The only thing the status granted was callability,
-- which `active` grants too, and what actually stops a demo reaching a real person is `is_demo` —
-- checked in `handleEscalate`, and the copy that fails closed. Carrying both meant every demo
-- question had two answers that could disagree.
--
-- The five rows that held it were the "Marisol Demo" sales pool, deleted in 0023. The two demo
-- lines that remain are `status = 'active'` with `is_demo = true` and are untouched by this.
--
-- ORDER MATTERS. Apply 0023 and deploy the worker that no longer accepts `demo` on
-- `POST/PATCH /admin/shops` before this runs. Against an older deployment, an admin write of
-- `status: 'demo'` stops being a validation error and becomes a 23514 from Postgres.
--
-- Rollback is a one-line CHECK swap; no data is dropped here.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shops WHERE status = 'demo') THEN
    RAISE EXCEPTION 'shops.status = demo still has rows; resolve them before contracting the CHECK';
  END IF;
END $$;

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_status_check;

ALTER TABLE shops
  ADD CONSTRAINT shops_status_check
  CHECK (status IN ('active', 'cancelled', 'suspended'));

-- `shops_demo_status_implies_is_demo` (0015) guarded the one direction the two fields had to
-- agree on. With the status gone it can never fail, so it is dead weight rather than a guard.
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_demo_status_implies_is_demo;
