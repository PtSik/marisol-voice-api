-- Sales demo shops are neither trials nor customers: they are pool rows whose name is rewritten per
-- prospect. Their own status stops them reading as five fake trials in the admin panel, which is
-- exactly where a real trial should be easy to spot. It labels the rows — nothing filters on it, so
-- they still appear in every listing, just no longer disguised as customers.
--
-- The constraint is already live: the pool rows carry status = 'demo' today and the old CHECK would
-- have refused them, so this commits the schema the database already has.

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_status_check;

ALTER TABLE shops
  ADD CONSTRAINT shops_status_check
  CHECK (status IN ('trial', 'active', 'cancelled', 'suspended', 'demo'));

-- The status is the discoverable marker; `is_demo` (migration 0014) is the one that does the work —
-- `handleEscalate` reads it to stop a demo handing a caller to a real person. Whoever adds the sixth
-- pool number will reach for the status, because it is the one they can see, so the two are tied
-- together here rather than left to be kept in sync by hand. A row marked demo but not flagged tells
-- a business owner testing their own salon that it is putting them through, and rings us instead.
--
-- The UPDATE has to run first: the CHECK is validated against existing rows, and 0014 left the
-- flagging to be done by hand.
UPDATE shops SET is_demo = true WHERE status = 'demo' AND NOT is_demo;

ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_demo_status_implies_is_demo;

-- One direction only. The two landing-widget shops are is_demo = true on a normal status, and they
-- are not pool rows.
ALTER TABLE shops
  ADD CONSTRAINT shops_demo_status_implies_is_demo
  CHECK (status <> 'demo' OR is_demo);
