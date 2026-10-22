# Marisol — AI Voice Receptionist (voice worker)

AI phone receptionist for barbershops and pet-grooming salons in the US. One shared Cloudflare
Worker serves every shop — shop context is resolved at runtime from the inbound Twilio number.

The customer-facing half of the product (marketing site, checkout, onboarding wizard, client
portal, provisioning, admin queue) lives in a separate repo: [`marisol-web`](https://github.com/PtSik/marisol-web).
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
| Calendar | Google Calendar via customer OAuth; service-account JWT support, no `googleapis` |
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
supabase/migrations/    Versioned SQL migrations (apply with the supabase CLI)
agent-templates/        ElevenLabs prompt sources + agent config snapshots
docs/                   PROJECT_SPEC.md (canonical), onboarding.md, diagrams/
```

## Local dev

The automated checks use mocked integrations and do not require provider accounts. Install
Bun and use the committed lockfile. CI pins its Bun version in
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

```bash
bun install --frozen-lockfile
cd apps/api
bun run typecheck
bun run test
bun run lint
```

To run the API locally:

```bash
cp .env.example .dev.vars
# Fill .dev.vars with credentials for your own development services.
bun run dev
```

The template is [`apps/api/.env.example`](./apps/api/.env.example). Real call and booking flows
need a separate Supabase database with the migrations applied, Twilio and ElevenLabs accounts,
and Google Calendar credentials for calendar integration. A local server alone does not simulate
those services. Keep SMS disabled during setup. Never use production customer data for demos.

CI runs formatting/lint, typechecking and tests on pull requests and pushes to `main`.
Tests exercise request handlers and business rules with mocks; they do not verify live phone
calls, provider dashboards or deployed database state.

## Engineering decisions

- **Tenant isolation:** shop resolution uses explicit call context; it does not guess from the
  most recent call across customers.
- **Voice-friendly failures:** tool errors retain a spoken `result` and `success` flag so the
  agent can explain a failure instead of leaving the caller waiting.
- **Calendar repair:** writes run outside the spoken response path, with pending state and a
  scheduled repair process for failed synchronization.
- **Server-enforced demo boundaries:** demo shops cannot transfer a caller to a real person,
  even if an agent prompt or dashboard configuration changes.

For a code walkthrough, start at [`src/index.ts`](./apps/api/src/index.ts), then
[`book-appointment.ts`](./apps/api/src/routes/tools/book-appointment.ts),
[`calendar-sync.ts`](./apps/api/src/lib/calendar-sync.ts) and the
[request-handler tests](./apps/api/src/__tests__/app/).

## Reviewing the product

The public product site is [callmarisol.com](https://callmarisol.com). The UI, billing and portal
implementation is in the companion repository. Live calls, checkout and provisioning use
external services; use the automated tests for a credential-free technical review.

## Launch gates

Three switches decide what the worker is allowed to do. All of them fail closed:

| Gate | Where | Effect when off |
|---|---|---|
| `SMS_ENABLED` (Worker var) | `wrangler.toml` | **every** SMS is blocked, deployment-wide. Off until US A2P brand + campaign are approved. |
| `shops.sms_enabled` | per shop | that shop sends no SMS, and `sms_available` reaches the agent as `"false"` |
| `bookings.sms_consent_at` | per recipient | customer messages are blocked without consent captured on the call |

Plus `shops.status` (`lib/shop-status.ts`): only `active` shops are served — a new
shop is provisioned `suspended` and released by hand during assisted launch.

See [`docs/PROJECT_SPEC.md`](./docs/PROJECT_SPEC.md) for the full contract.

Tool webhooks also fail closed: missing `TOOLS_WEBHOOK_SECRET` returns 503, and an invalid
`X-Tool-Secret` returns 401. The template and deployed agent must use matching values.
