import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import { buildReferralUpdate } from '../../routes/admin/referrals';
import type { WorkerBindings } from '../../types';

// Same trick as admin-accounts.test.ts: an empty SUPABASE_URL makes the DB call throw, so a
// request that reaches Supabase surfaces as 500 — that separates "passed validation" from
// "blocked at validation" (400) without a live database.
const env = {
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_API_KEYS: 'testkey',
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function call(path: string, init: RequestInit = {}, auth = true) {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer testkey' } : {}),
      },
    }),
    env,
    ctx,
  );
}

describe('/admin/referrals', () => {
  it('requires admin auth', async () => {
    const res = await call('/admin/referrals', {}, false);
    expect(res.status).toBe(401);
  });

  it('lets a filtered list through to the DB', async () => {
    const res = await call('/admin/referrals?status=qualified&mature_before=2026-07-23T00:00:00Z');
    expect(res.status).toBe(500);
  });

  it('rejects a create without a referral code', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referred_lead_id: 'lead-1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('referral_code');
  });

  it('rejects a create without a referred lead id', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referral_code: 'ABCD1234' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('referred_lead_id');
  });

  it('lets a valid create through to the DB', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referral_code: 'ABCD1234', referred_lead_id: 'lead-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects a patch with no updatable fields', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ amount_cents: 999999, referrer_account_id: 'spoofed' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('rejects a patch with an unknown status', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'refunded' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a patch with an unknown expected_status', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'credited', expected_status: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('lets a valid compare-and-set patch through to the DB', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'crediting', expected_status: 'qualified' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('buildReferralUpdate', () => {
  it('drops fields outside the whitelist', () => {
    const built = buildReferralUpdate({
      status: 'void',
      amount_cents: 1,
      referrer_account_id: 'spoofed',
    });
    expect(built).toEqual({ update: { status: 'void' } });
  });

  it('keeps expected_status out of the update', () => {
    const built = buildReferralUpdate({ status: 'credited', expected_status: 'crediting' });
    expect(built).toEqual({ update: { status: 'credited' } });
  });

  it('rejects an unknown status', () => {
    expect(buildReferralUpdate({ status: 'refunded' })).toEqual({ error: 'invalid status' });
  });

  it('rejects a body with nothing updatable', () => {
    expect(buildReferralUpdate({ id: 'x' })).toEqual({ error: 'No updatable fields provided' });
  });
});
