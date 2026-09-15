-- Legacy shops retain transfer behavior and their existing service representation.
-- New onboarding writes an explicit fixed-duration catalog and disables untested transfers.
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS transfers_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS service_catalog jsonb;
