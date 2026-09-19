import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { validateTwilioSignature } from '../../lib/twilio-signature';
import { handleTwilioSms } from '../../routes/twilio/sms';
import type { WorkerBindings } from '../../types';

const AUTH_TOKEN = 'twilio-test-token';
const URL = 'https://api.callmarisol.com/twilio/sms';

// Supabase is reachable only past the keyword branch, so credentials that throw on read are the
// assertion: if a HELP text ever reaches the preference upsert, the test fails with that access
// rather than silently writing an opt-out state in production.
function ctx(body: string): Context<{ Bindings: WorkerBindings }> {
  const params = { From: '+13055550111', To: '+17545550100', Body: body };
  const env = {
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    get SUPABASE_URL(): never {
      throw new Error('a no-write keyword reached Supabase — the branch did not hold');
    },
    get SUPABASE_SERVICE_ROLE_KEY(): never {
      throw new Error('a no-write keyword reached Supabase — the branch did not hold');
    },
  } as unknown as WorkerBindings;

  return {
    env,
    req: {
      get raw(): Request {
        const form = new FormData();
        for (const [k, v] of Object.entries(params)) form.append(k, v);
        return new Request(URL, {
          method: 'POST',
          body: form,
          headers: { 'X-Twilio-Signature': signature },
        });
      },
    },
    text: (content: string, status?: number) => new Response(content, { status: status ?? 200 }),
  } as unknown as Context<{ Bindings: WorkerBindings }>;
}

let signature = '';
async function sign(body: string): Promise<void> {
  const params = { Body: body, From: '+13055550111', To: '+17545550100' };
  const sorted = Object.keys(params).sort();
  const message = URL + sorted.map((k) => `${k}${params[k as keyof typeof params]}`).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  signature = btoa(String.fromCharCode(...new Uint8Array(digest)));
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

describe('POST /twilio/sms — keywords that must not write a preference', () => {
  for (const body of ['HELP', 'info', 'what are your hours?']) {
    it(`answers ${JSON.stringify(body)} with empty TwiML and touches no preference`, async () => {
      await sign(body);
      const res = await handleTwilioSms(ctx(body));

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/xml');
      expect(await res.text()).toBe(EMPTY_TWIML);
    });
  }

  it('still verifies the Twilio signature before reading the keyword', async () => {
    await sign('HELP');
    signature = 'not-the-real-signature';
    const res = await handleTwilioSms(ctx('HELP'));
    expect(res.status).toBe(403);
  });

  it('signs the fixture the way the route verifies it', async () => {
    await sign('HELP');
    await expect(
      validateTwilioSignature(
        AUTH_TOKEN,
        URL,
        { Body: 'HELP', From: '+13055550111', To: '+17545550100' },
        signature,
      ),
    ).resolves.toBe(true);
  });
});
