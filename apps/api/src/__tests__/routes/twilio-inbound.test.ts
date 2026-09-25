import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import worker from '../../index';
import { validateTwilioSignature } from '../../lib/twilio-signature';
import type { WorkerBindings } from '../../types';

const AUTH_TOKEN = 'twilio-auth-token';
const URL_INBOUND = 'https://api.test/twilio/inbound';

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  ELEVENLABS_API_KEY: 'xi-key',
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SHOP = {
  id: 'shop_1',
  name: 'Barbarossa Barbershop',
  twilio_number: '+18336596941',
  escalation_phone: '+13055550111',
  owner_escalation_phone: '+13055550222',
  owner_email: 'owner@example.com',
  timezone: 'America/New_York',
  status: 'active',
  integration: 'none',
  integration_credentials_encrypted: null,
  calendar_routing: null,
  staff_json: '[]',
  hours_json: '{"Sun-Sat":"9am-7pm"}',
  closures_json: '[]',
  service_catalog: [{ name: 'Haircut', duration_minutes: 30 }],
  primary_language: 'en',
  reminders_enabled: false,
  elevenlabs_agent_id: 'agent_barber',
};

// Twilio signs the full URL plus its sorted form keys and values, so the test has to sign the same
// way — an unsigned request is rejected before any of this is reached.
async function sign(params: Record<string, string>): Promise<string> {
  const sorted = Object.keys(params).sort();
  const message = URL_INBOUND + sorted.map((k) => `${k}${params[k]}`).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

let registerCalls: { agent_id?: string }[] = [];
let shopRow: Record<string, unknown> | null = SHOP;
const realFetch = globalThis.fetch;

beforeEach(() => {
  registerCalls = [];
  shopRow = SHOP;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/rest/v1/shops') {
      return Response.json(shopRow);
    }
    if (url.pathname === '/v1/convai/twilio/register-call') {
      registerCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        '<?xml version="1.0"?><Response><Connect><Stream><Parameter name="conversation_id" value="conv_1"/></Stream></Connect></Response>',
        { status: 200 },
      );
    }
    return Response.json([]);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(): Promise<Response> {
  const params = { To: SHOP.twilio_number, From: '+13055550199', CallSid: 'CA1' };
  return worker.fetch(
    new Request(URL_INBOUND, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': await sign(params),
      },
      body: new URLSearchParams(params).toString(),
    }),
    env,
    ctx,
  );
}

describe('POST /twilio/inbound — which agent answers', () => {
  it('hands the call to the shop’s own agent', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]?.agent_id).toBe('agent_barber');
  });

  // There is no template agent behind this any more. A shop with none used to be answered by
  // whichever vertical the secret pointed at — the wrong trade, spoken confidently, with nothing
  // in the logs. Refusing is the honest failure, and the caller hears a sentence rather than
  // Twilio's application-error tone.
  it('refuses the call instead of answering with a stand-in agent', async () => {
    shopRow = { ...SHOP, elevenlabs_agent_id: null };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('not in service');
    expect(registerCalls).toHaveLength(0);
  });

  it('rejects a request Twilio did not sign', async () => {
    const res = await worker.fetch(
      new Request(URL_INBOUND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: SHOP.twilio_number, From: '+13055550199' }).toString(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe('validateTwilioSignature', () => {
  it('accepts the signature it describes and nothing else', async () => {
    const params = { To: '+18336596941', From: '+13055550199' };
    const good = await sign(params);
    expect(await validateTwilioSignature(AUTH_TOKEN, URL_INBOUND, params, good)).toBe(true);
    expect(await validateTwilioSignature(AUTH_TOKEN, URL_INBOUND, params, 'nope')).toBe(false);
  });
});
