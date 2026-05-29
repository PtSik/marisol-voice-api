# Voice Agent — AI Voice Receptionist

AI phone receptionist for barber shops. One shared Cloudflare Worker serves all shops — shop context is resolved at runtime by the inbound Twilio number.

## Architecture

- **Runtime**: Hono on Cloudflare Workers (TypeScript strict)
- **Database**: Supabase Postgres (HTTP client, no TCP pool)
- **Voice AI**: ElevenLabs Agents (single template agent, personalized per-call)
- **Telephony**: Twilio Voice + SMS
- **LLM**: Anthropic Claude Haiku 4.5 (via OAI-compatible streaming proxy)
- **Calendar**: Google Calendar (RSASSA-PKCS1-v1_5 JWT, no googleapis package)

## Structure

```
apps/api/src/
  index.ts              — Hono app entry + Worker export
  types.ts              — Extended WorkerBindings (superset of docs/api/types.ts)
  lib/
    supabase.ts         — Per-request Supabase client factory
    crypto.ts           — AES-256-GCM encrypt/decrypt + HMAC-SHA256
    normalize.ts        — Phone number E.164 normalization
    verification.ts     — SMS verification code generate/store/verify
    elevenlabs.ts       — ElevenLabs thin client (register-call, getAgent)
    integrations/       — GCal JWT auth + calendar operations
  routes/
    webhooks/           — ElevenLabs personalization + post-call webhooks
    twilio/             — Twilio inbound call handler
    tools/              — 6 tool endpoints called by ElevenLabs during calls
    llm/                — Anthropic proxy (module-level fetch, not Hono)
    admin/              — Shop management API
  middleware/           — HMAC verification, shop lookup
  cron/                 — Appointment reminder job
supabase/migrations/    — SQL migrations (apply via supabase CLI)
agent-templates/        — ElevenLabs agent config snapshots
docs/
  api/types.ts          — Canonical TypeScript interfaces
  research/             — Research findings (ElevenLabs, Hono/Workers, GCal)
  diagrams/             — Architecture + DB schema (Mermaid)
```

## Local dev

```bash
cd apps/api
bun install
bun run dev         # wrangler dev
bun run typecheck   # tsc --noEmit
```

