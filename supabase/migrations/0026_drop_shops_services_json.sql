-- Drops `shops.services_json`. The spoken service list is now rendered from `service_catalog`,
-- which also decides bookable durations — one field instead of two that nothing kept in step.
--
-- STAGED: this must run AFTER the worker that stops reading the column is deployed, which is the
-- reverse of the usual order. Until then `buildPersonalizationData` still needs it to exist.
--
-- What the column held that `service_catalog` did not, before this ran: the price per service.
-- Landing now sends `price` / `price_max` on the catalog, so nothing is lost for a shop saved
-- after that deploy. A shop last saved before it keeps its durations and loses its prices from
-- the spoken summary until its owner saves the setup once — there is exactly one such shop, and
-- it is an internal test shop.

ALTER TABLE public.shops DROP COLUMN IF EXISTS services_json;
