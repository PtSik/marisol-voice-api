# Marisol — AI Voice Receptionist (voice worker)

AI phone receptionist for barbershops and pet-grooming salons in the US. One shared Cloudflare
Worker serves every shop — shop context is resolved at runtime from the inbound Twilio number.

The customer-facing half of the product (marketing site, checkout, onboarding wizard, client
portal, provisioning, admin queue) lives in a separate repo: [`kaijiro-voice-landing`](./kaijiro-voice-landing).
This repo is the **voice worker** plus its Supabase schema.

- **Worker:** `voice-agent-api` → `https://api.callmarisol.com`
- **Site + portal:** `callmarisol.com` / `app.callmarisol.com` (landing repo)

## Architecture

| Layer | Technology |
|---|---|
| Runtime | Hono v4 on Cloudflare Workers (TypeScript strict) |
| Database | Supabase Postgres via `supabase-js` (HTTP, service-role key, no TCP pool) |
| Voice AI | ElevenLabs Conversational AI — two template agents (barber, grooming), personalized per call |
| Telephony | Twilio Voice (inbound) + Twilio SMS (outbound, launch-gated) |
| Calendar | Google Calendar via self-serve OAuth (hand-rolled RS256 JWT, no `googleapis`) |
| Alerting | Discord incoming webhook |
| Linter | Biome · **Package manager** bun |

Diagrams (Mermaid) live in [`docs/diagrams/`](./docs/diagrams/). For how the two repos fit
together technically — workers, bindings, datastores, third parties — read
[`docs/diagrams/system.md`](./docs/diagrams/system.md) first;
[`docs/diagrams/README.md`](./docs/diagrams/README.md) indexes the rest.

## Structure

```
apps/api/src/
  index.ts              Hono app entry, route mounting, onError, scheduled() cron dispatch
  types.ts              Every TypeScript interface, incl. WorkerBindings
  routes/
    twilio/             inbound call handler + SMS keyword (STOP/START/HELP) handler
    webhooks/           ElevenLabs personalization + post-call webhooks
    tools/              the 6 tool endpoints ElevenLabs calls mid-conversation
    admin/              shops, accounts, referrals (bearer-token admin API)
    integrations/       Google Calendar OAuth start/callback + calendar picker
  middleware/           ElevenLabs HMAC, tool shared secret, admin auth
  lib/                  supabase, gcal, sms, sms-templates, hours, staff, service-catalog,
                        shop-status, verification, crypto, attribution, calendar-sync,
                        calendar-alerts, reminders, discord, password, normalize, elevenlabs
  __tests__/            bun test — lib / middleware / routes / app
supabase/migrations/    SQL migrations 0001…0019 (apply with the supabase CLI)
agent-templates/        ElevenLabs prompt sources + agent config snapshots
docs/                   PROJECT_SPEC.md (canonical), onboarding.md, diagrams/, research
```

## Local dev

```bash
cd apps/api
bun install            # from the repo root
bun run dev            # wrangler dev
bun run typecheck      # tsc --noEmit
bun run test           # bun test — 295 tests
bun run lint           # biome check src/
bun run deploy         # wrangler deploy
```

CI (`.github/workflows/ci.yml`) runs `biome ci`, `typecheck` and `test` on every PR and on
pushes to `main`. `biome ci` does not write fixes — run `bunx biome check --fix src/` first.

## Launch gates

Three switches decide what the worker is allowed to do. All of them fail closed:

| Gate | Where | Effect when off |
|---|---|---|
| `SMS_ENABLED` (Worker var) | `wrangler.toml` | **every** SMS is blocked, deployment-wide. Off until US A2P brand + campaign are approved. |
| `shops.sms_enabled` | per shop | that shop sends no SMS, and `sms_available` reaches the agent as `"false"` |
| `bookings.sms_consent_at` | per recipient | customer messages are blocked without consent captured on the call |

Plus `shops.status` (`lib/shop-status.ts`): only `active`, `trial` and `demo` are served — a new
shop is provisioned `suspended` and released by hand during assisted launch.

See [`docs/PROJECT_SPEC.md`](./docs/PROJECT_SPEC.md) for the full contract.
