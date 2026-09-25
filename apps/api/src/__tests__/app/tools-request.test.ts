import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import worker from '../../index';
import type { WorkerBindings } from '../../types';

// The tool routes are exercised end to end over a stand-in PostgREST, so the wrapper's parse,
// shop resolution and each handler's writes are all the real code paths.
const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  TOOLS_WEBHOOK_SECRET: 'tool-secret',
  // SMS_ENABLED unset: sendSms refuses before any network or preference read, as in production.
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SHOP = {
  id: 'shop_1',
  name: 'Pampered Paws',
  twilio_number: '+17545550100',
  escalation_phone: '+13055550111',
  owner_escalation_phone: '+13055550222',
  timezone: 'America/New_York',
  status: 'active',
  integration: 'none',
  integration_credentials_encrypted: null,
  calendar_routing: null,
  staff_json: JSON.stringify([{ id: 'stf_ana', name: 'Ana' }]),
  hours_json: JSON.stringify({
    Mon: '9am-6pm',
    Tue: '9am-6pm',
    Wed: '9am-6pm',
    Thu: '9am-6pm',
    Fri: '9am-6pm',
    Sat: '9am-6pm',
    Sun: '9am-6pm',
  }),
  closures_json: '[]',
  service_catalog: [{ name: 'Full groom', duration_minutes: 60 }],
  primary_language: 'en',
  reminders_enabled: false,
  sms_enabled: false,
};

// 10:00 local in the shop's timezone, a week out — inside hours and never in the past.
function nextWeekAt10(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const day = d.toLocaleDateString('en-CA', { timeZone: SHOP.timezone });
  return new Date(`${day}T14:00:00.000Z`).toISOString();
}

interface Recorded {
  method: string;
  path: string;
  body: string | undefined;
}

let calls: Recorded[] = [];
let shopRow: Record<string, unknown> | null = SHOP;
const realFetch = globalThis.fetch;
const realParse = JSON.parse;

beforeEach(() => {
  calls = [];
  shopRow = SHOP;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ method, path: url.pathname, body });

    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/rest/v1/shops') return json(shopRow);
    if (url.pathname === '/rest/v1/calls') return json({ shops: shopRow });
    if (url.pathname === '/rest/v1/bookings' && method === 'POST') {
      return json({ id: 'bk_1', ...(body ? realParse(body) : {}) });
    }
    if (url.pathname === '/rest/v1/bookings') return json([]);
    if (url.pathname === '/rest/v1/verification_codes') return json({ id: 'vc_1' });
    return json([]);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  JSON.parse = realParse;
});

const wrote = (path: string) =>
  calls.some((call) => call.method === 'POST' && call.path === `/rest/v1/${path}`);

async function tool(name: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request(`https://api.test/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tool-Secret': 'tool-secret', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await res.text();
  return { status: res.status, body: realParse(text) as { result: string; success: boolean } };
}

const bookingParams = () => ({
  staff_name: 'Ana',
  start_time: nextWeekAt10(),
  duration_minutes: 60,
  service: 'Full groom',
  customer_phone: '+13055559999',
  customer_name: 'Rosa',
});

describe('tool requests — where the phone context is read from', () => {
  it('books from a flat body with called_number alongside the params', async () => {
    const res = await tool('book_appointment', {
      called_number: SHOP.twilio_number,
      ...bookingParams(),
    });

    expect(res.body.success).toBe(true);
    expect(wrote('bookings')).toBe(true);
  });

  it('books from a body with called_number nested under parameters', async () => {
    const res = await tool('book_appointment', {
      parameters: { called_number: SHOP.twilio_number, ...bookingParams() },
    });

    expect(res.body.success).toBe(true);
    expect(wrote('bookings')).toBe(true);
  });

  // The shape the validation report flagged: unwrapping `parameters` and looking no further
  // would read this supported request as a browser demo and confirm without booking anything.
  it('books when called_number is outside parameters and the params are nested', async () => {
    const res = await tool('book_appointment', {
      called_number: SHOP.twilio_number,
      parameters: bookingParams(),
    });

    expect(res.body.success).toBe(true);
    expect(wrote('bookings')).toBe(true);
  });
});

describe('tool requests — the browser demo writes nothing', () => {
  it('confirms a booking without touching the database or SMS', async () => {
    const res = await tool('book_appointment', {
      shop_id: SHOP.id,
      parameters: bookingParams(),
    });

    expect(res.body.success).toBe(true);
    expect(res.body.result).toMatch(/in the real product/i);
    expect(wrote('bookings')).toBe(false);
    expect(wrote('verification_codes')).toBe(false);
    expect(calls.some((call) => call.path.includes('twilio'))).toBe(false);
  });

  it('short-circuits cancel without reading or writing a booking', async () => {
    const res = await tool('cancel_appointment', {
      shop_id: SHOP.id,
      parameters: { booking_id: 'bk_1', code: '123456' },
    });

    expect(res.body.success).toBe(true);
    expect(calls.filter((call) => call.path === '/rest/v1/bookings')).toHaveLength(0);
  });

  it('short-circuits reschedule without reading or writing a booking', async () => {
    const res = await tool('reschedule_appointment', {
      shop_id: SHOP.id,
      parameters: { booking_id: 'bk_1', code: '123456', new_start_time: nextWeekAt10() },
    });

    expect(res.body.success).toBe(true);
    expect(calls.filter((call) => call.path === '/rest/v1/bookings')).toHaveLength(0);
  });

  // An unsubstituted template is not a phone number. Treating it as one would send the demo
  // down the writing path with a called_number nothing can resolve.
  it('treats an unsubstituted called_number placeholder as a demo', async () => {
    const res = await tool('book_appointment', {
      shop_id: SHOP.id,
      called_number: '{{called_number}}',
      parameters: bookingParams(),
    });

    expect(res.body.result).toMatch(/in the real product/i);
    expect(wrote('bookings')).toBe(false);
  });
});

describe('tool requests — refusals keep the tool response shape', () => {
  it('answers a malformed body with a 404 in tool shape, not a 500', async () => {
    const res = await tool('check_availability', '{ this is not json');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.result).toMatch(/Unknown conversation or shop/);
  });

  it('answers an unknown shop with a 404 in tool shape', async () => {
    shopRow = null;
    const res = await tool('check_availability', {
      shop_id: 'nope',
      parameters: { date: '2026-10-01' },
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // A suspended shop resolves but must not be served — and must not fall through to the
  // twilio_number rung, where a recycled number would answer as somebody else.
  it('refuses an uncallable shop rather than resolving it another way', async () => {
    shopRow = { ...SHOP, status: 'suspended' };
    const res = await tool('check_availability', {
      shop_id: SHOP.id,
      called_number: SHOP.twilio_number,
      parameters: { date: '2026-10-01' },
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('tool requests — conversation id and parsing', () => {
  it('prefers the header over the body for the booking idempotency key', async () => {
    await tool(
      'book_appointment',
      { called_number: SHOP.twilio_number, conversation_id: 'conv_body', ...bookingParams() },
      { 'X-Conversation-Id': 'conv_header' },
    );

    const insert = calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/bookings');
    expect(insert?.body).toContain('conv_header');
    expect(insert?.body).not.toContain('conv_body');
  });

  it('falls back to the body conversation id when no header is sent', async () => {
    await tool('book_appointment', {
      called_number: SHOP.twilio_number,
      conversation_id: 'conv_body',
      ...bookingParams(),
    });

    const insert = calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/bookings');
    expect(insert?.body).toContain('conv_body');
  });

  it('resolves a shop from the conversation id when nothing else identifies it', async () => {
    const res = await tool('check_availability', {
      conversation_id: 'conv_1',
      parameters: { date: '2026-10-01' },
    });

    expect(res.status).toBe(200);
    expect(calls.some((call) => call.path === '/rest/v1/calls')).toBe(true);
  });

  it('parses the request body exactly once', async () => {
    const body = JSON.stringify({
      shop_id: SHOP.id,
      parameters: { date: '2026-10-01' },
    });
    let parsedBody = 0;
    JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) => {
      if (text === body) parsedBody++;
      return realParse(text, reviver);
    }) as typeof JSON.parse;

    await tool('check_availability', body);

    expect(parsedBody).toBe(1);
  });
});
