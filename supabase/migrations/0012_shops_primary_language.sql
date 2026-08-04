-- Which language the agent opens the call in. The other one stays available mid-call via
-- the language_detection tool, so this only picks the opening side, never restricts the call.
-- 'en' keeps every existing shop on today's behaviour.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS primary_language TEXT NOT NULL DEFAULT 'en'
  CHECK (primary_language IN ('en', 'es'));
