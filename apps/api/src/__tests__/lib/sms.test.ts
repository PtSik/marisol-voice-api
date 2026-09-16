import { afterEach, describe, expect, it } from 'bun:test';
import { sendSms } from '../../lib/sms';
import type { WorkerBindings } from '../../types';

const originalFetch = globalThis.fetch;
const shop = { id: 'shop-1', twilio_number: '+13055550100', sms_enabled: true };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function env(smsEnabled?: string): WorkerBindings {
  return {
    SMS_ENABLED: smsEnabled,
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'secret',
    SUPABASE_URL: 'https://database.example',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  } as unknown as WorkerBindings;
}

function mockPreference(status: 'opted_in' | 'opted_out' | null) {
  let twilioRequest: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith('https://database.example')) {
      return new Response(JSON.stringify(status ? { status } : null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    twilioRequest = request;
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return () => twilioRequest;
}

describe('sendSms safety gates', () => {
  it('fails closed when the global switch is missing', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    expect(await sendSms(env(), shop, '+13055550101', 'test', { consentAt: 'now' })).toBe(false);
    expect(calls).toBe(0);
  });

  it('requires explicit approval for the shop', async () => {
    expect(
      await sendSms(env('true'), { ...shop, sms_enabled: false }, '+13055550101', 'test', {
        consentAt: 'now',
      }),
    ).toBe(false);
  });

  it('requires recorded consent for customer messages', async () => {
    expect(await sendSms(env('true'), shop, '+13055550101', 'test')).toBe(false);
  });

  it('blocks a recipient who opted out', async () => {
    const sentRequest = mockPreference('opted_out');
    expect(await sendSms(env('true'), shop, '+13055550101', 'test', { consentAt: 'now' })).toBe(
      false,
    );
    expect(sentRequest()).toBeUndefined();
  });

  it('sends only when launch, shop, consent and preference checks pass', async () => {
    const sentRequest = mockPreference(null);
    expect(await sendSms(env('true'), shop, '+13055550101', 'test', { consentAt: 'now' })).toBe(
      true,
    );
    expect(sentRequest()?.url).toContain('/Accounts/AC_test/Messages.json');
    expect(await sentRequest()?.text()).toContain('From=%2B13055550100');
  });
});
