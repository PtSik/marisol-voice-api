-- SMS stays fail-closed at three levels: deployment, shop approval and recipient consent.
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS sms_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;

CREATE TABLE IF NOT EXISTS public.sms_preferences (
  sender_phone text NOT NULL,
  phone       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
  source      text NOT NULL DEFAULT 'keyword',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_phone, phone)
);

ALTER TABLE public.sms_preferences ENABLE ROW LEVEL SECURITY;
