import { afterEach, describe, expect, it } from 'bun:test';
import { sendSms } from '../../lib/sms';
import type { WorkerBindings } from '../../types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function env(smsEnabled?: string): WorkerBindings {
  return {
    SMS_ENABLED: smsEnabled,
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'secret',
  } as unknown as WorkerBindings;
}

describe('sendSms launch gate', () => {
  it('fails closed when SMS_ENABLED is missing', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    expect(await sendSms(env(), '+13055550100', '+13055550101', 'test')).toBe(false);
    expect(calls).toBe(0);
  });

  it('does not accept a truthy value other than the explicit string true', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    expect(await sendSms(env('1'), '+13055550100', '+13055550101', 'test')).toBe(false);
    expect(calls).toBe(0);
  });

  it('sends only after production explicitly opts in', async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    expect(await sendSms(env('true'), '+13055550100', '+13055550101', 'test')).toBe(true);
    expect(request?.url).toContain('/Accounts/AC_test/Messages.json');
    expect(await request?.text()).toContain('From=%2B13055550100');
  });
});
