import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import { buildAccountUpdate } from '../../routes/admin/accounts';
import type { WorkerBindings } from '../../types';

// Same trick as admin-shops.test.ts: an empty SUPABASE_URL makes the DB call throw, so a
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

describe('/admin/accounts', () => {
  it('requires admin auth', async () => {
    const res = await call('/admin/accounts?email=a@b.com', {}, false);
    expect(res.status).toBe(401);
  });

  it('rejects a lookup without an email', async () => {
    const res = await call('/admin/accounts');
    expect(res.status).toBe(400);
  });

  it('lets a lookup with an email through to the DB', async () => {
    const res = await call('/admin/accounts?email=a@b.com');
    expect(res.status).toBe(500);
  });

  it('rejects a create without an email', async () => {
    const res = await call('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ shop_id: 'abc' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('email');
  });

  it('rejects a create with a blank email', async () => {
    const res = await call('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('lets a valid create through to the DB', async () => {
    const res = await call('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: 'Owner@Shop.com', lead_id: 'lead-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects a patch with no updatable fields', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'spoofed', referral_code: 'HACKED' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('lets a valid patch through to the DB', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ google_sub: '1234', last_login_at: '2026-07-23T00:00:00Z' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('buildAccountUpdate', () => {
  it('drops fields outside the whitelist', () => {
    const built = buildAccountUpdate({ google_sub: 'x', referral_code: 'nope', id: 'spoofed' });
    expect(built).toEqual({ update: { google_sub: 'x' } });
  });

  it('lets lead_id through', () => {
    const built = buildAccountUpdate({ lead_id: 'lead-9' });
    expect(built).toEqual({ update: { lead_id: 'lead-9' } });
  });

  it('lowercases and trims the email', () => {
    const built = buildAccountUpdate({ email: '  Owner@Shop.COM ' });
    expect(built).toEqual({ update: { email: 'owner@shop.com' } });
  });

  it('rejects a blank email', () => {
    const built = buildAccountUpdate({ email: '  ' });
    expect(built).toEqual({ error: 'email must be a non-empty string' });
  });
});
