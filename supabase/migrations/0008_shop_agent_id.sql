-- 0002_shop_agent_id.sql
-- Per-shop ElevenLabs agent override. NULL → fall back to the env template agent.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS elevenlabs_agent_id TEXT;
