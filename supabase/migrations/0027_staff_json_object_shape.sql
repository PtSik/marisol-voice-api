-- Converts the last shops holding the retired `staff_json` string[] shape to the stored
-- `[{id, name}]` one, so the worker no longer has to accept two rosters.
--
-- The legacy branch in `parseStaff` was kept "so existing shops keep working without a data
-- migration". This is that migration: four rows, two of them callable.
--
-- STAGED: apply BEFORE deploying the worker that drops the branch. Against an older schema the
-- new code reads a string[] roster as EMPTY, and an empty roster books anyone the caller names
-- without checking a schedule — the one thing `resolveStaffForBooking` exists to prevent.
--
-- The ids are exactly what `slugId` derives from each name, so nothing that already keyed on a
-- derived id (calendar_routing.staff_calendars, per-member hours) moves. Written out per row
-- rather than generated in SQL: the slug rules include a dedupe suffix, and four rows are not
-- worth reimplementing them in plpgsql to get wrong.

UPDATE shops SET staff_json = '[{"id":"stf_joe","name":"Joe"},{"id":"stf_mike","name":"Mike"},{"id":"stf_sara","name":"Sara"}]'
WHERE id = '4d5815c1-c77a-43cc-8df4-1b0b7be6c896';

UPDATE shops SET staff_json = '[{"id":"stf_maria","name":"Maria"},{"id":"stf_carlos","name":"Carlos"},{"id":"stf_ashley","name":"Ashley"}]'
WHERE id = 'da61e1fa-787a-4069-b3a6-246bd95144da';

-- Both cancelled: converted so no row is left in a shape nothing can read, not because they serve.
UPDATE shops SET staff_json = '[{"id":"stf_alex","name":"alex"},{"id":"stf_kevin","name":"Kevin"}]'
WHERE id = '9cd3f634-97d1-4095-9146-8f1f94715632';

UPDATE shops SET staff_json = '[{"id":"stf_alex","name":"Alex"},{"id":"stf_kevin","name":"Kevin"}]'
WHERE id = '3f9e5c6d-1f01-4b0a-b8c8-490983beca4c';

DO $$
DECLARE leftover int;
BEGIN
  SELECT count(*) INTO leftover FROM shops
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(staff_json::jsonb) e WHERE jsonb_typeof(e) = 'string'
  );
  IF leftover > 0 THEN
    RAISE EXCEPTION 'staff_json: % row(s) still hold the string[] shape', leftover;
  END IF;
END $$;
