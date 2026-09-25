-- Gives the two landing-page demo shops a `service_catalog`, so they keep working once
-- `services_summary` is rendered from that field instead of `services_json`.
--
-- These two rows are NOT leftovers, which is why they are not deleted here. `lib/demoAgents.ts`
-- in the landing repo hardcodes their ids and numbers, and the browser demo's token endpoint
-- calls `/webhooks/personalization` with `called_number` set to them: the shop row is where the
-- public "try it live" demo gets its hours, staff and services. Their Twilio numbers have been
-- released, which changes nothing here — that lookup never leaves Supabase. Deleting them would
-- make `fetchDynamicVariables` throw and the token endpoint answer 502, taking the demo on
-- callmarisol.com down with it.
--
-- Transcribed by hand from each row's `services_json`, not parsed: the durations and prices below
-- are the same numbers the demo already speaks. Barbershop services are flat; grooming quotes a
-- spread, which is why the catalog carries optional upper bounds at all.
--
-- STAGED: run this BEFORE deploying the worker that reads the summary from `service_catalog`.
-- Between the two, these shops would answer with an empty service list.

UPDATE shops SET service_catalog = '[
  {"name":"Haircut","duration_minutes":30,"price":35},
  {"name":"Skin Fade","duration_minutes":40,"price":40},
  {"name":"Buzz Cut","duration_minutes":20,"price":25},
  {"name":"Beard Trim","duration_minutes":20,"price":20},
  {"name":"Haircut + Beard","duration_minutes":45,"price":50},
  {"name":"Hot Towel Shave","duration_minutes":30,"price":40},
  {"name":"Haircut + Hot Towel Shave","duration_minutes":60,"price":70},
  {"name":"Line-Up","duration_minutes":15,"price":15},
  {"name":"Kids Cut (under 12)","duration_minutes":30,"price":25},
  {"name":"Senior Cut (65+)","duration_minutes":30,"price":25}
]'::jsonb
WHERE id = '4d5815c1-c77a-43cc-8df4-1b0b7be6c896';

UPDATE shops SET service_catalog = '[
  {"name":"Bath & Brush","duration_minutes":45,"duration_max_minutes":90,"price":45,"price_max":85},
  {"name":"Bath & Tidy","duration_minutes":60,"duration_max_minutes":120,"price":55,"price_max":95},
  {"name":"Full Groom","duration_minutes":75,"duration_max_minutes":180,"price":65,"price_max":135},
  {"name":"Doodle & Poodle Full Groom","duration_minutes":120,"duration_max_minutes":240,"price":95,"price_max":175},
  {"name":"Puppy''s First Groom","duration_minutes":45,"duration_max_minutes":60,"price":45},
  {"name":"De-Shedding Treatment","duration_minutes":60,"duration_max_minutes":120,"price":55,"price_max":95},
  {"name":"De-Matting","duration_minutes":30,"duration_max_minutes":60,"price":25,"price_max":60},
  {"name":"Flea & Tick Bath","duration_minutes":60,"duration_max_minutes":90,"price":65,"price_max":95},
  {"name":"Nail Trim","duration_minutes":15,"price":15},
  {"name":"Nail Grind","duration_minutes":20,"price":20},
  {"name":"Teeth Brushing","duration_minutes":10,"price":12},
  {"name":"Ear Cleaning","duration_minutes":10,"price":10}
]'::jsonb
WHERE id = 'da61e1fa-787a-4069-b3a6-246bd95144da';
