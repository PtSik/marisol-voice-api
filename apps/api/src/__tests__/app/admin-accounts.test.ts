import { afterEach, describe, expect, it } from 'bun:test';
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

  it("requires admin auth to list an account's shops", async () => {
    const res = await call('/admin/accounts/acc-1/shops', {}, false);
    expect(res.status).toBe(401);
  });

  it('lets a shops lookup through to the DB', async () => {
    const res = await call('/admin/accounts/acc-1/shops');
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

  it('lets email_verified through a patch to the DB', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ email_verified: true }),
    });
    expect(res.status).toBe(500);
  });

  it('hashes a password on patch and lets it through to the DB', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ password: 'new-password-123' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects a patch with a blank password', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ password: '' }),
    });
    expect(res.status).toBe(400);
  });

  // `role` was dropped in migration 0024; a patch that still carries it must not reach the DB
  // and get a column error back.
  it('no longer accepts role on patch', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('ignores a raw password_hash on patch (not settable directly)', async () => {
    const res = await call('/admin/accounts/abc', {
      method: 'PATCH',
      body: JSON.stringify({ password_hash: 'fake-hash-injected' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('hashes a password on create and lets it through to the DB', async () => {
    const res = await call('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@shop.com', password: 'new-password-123' }),
    });
    expect(res.status).toBe(500);
  });

  it('ignores a raw password_hash on create (not settable directly)', async () => {
    const res = await call('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@shop.com', password_hash: 'fake-hash-injected' }),
    });
    // still reaches the DB — the point is password_hash never makes it into the insert payload,
    // which isn't observable from the HTTP boundary, so this only proves it doesn't crash the route.
    expect(res.status).toBe(500);
  });
});

// A live-looking Supabase that always answers the email lookup with an existing account: the only
// way to reach the branch that decides between get-or-create and a sign-up conflict.
describe('POST /admin/accounts against an email that already exists', () => {
  const account = { id: 'acc-1', email: 'owner@shop.com', referral_code: 'ABC', role: 'client' };
  const dbEnv = {
    SUPABASE_URL: 'https://db.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    ADMIN_API_KEYS: 'testkey',
  } as unknown as WorkerBindings;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function post(body: Record<string, unknown>) {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes('/rest/') ? [account] : {}), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    return worker.fetch(
      new Request('https://example.com/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer testkey' },
        body: JSON.stringify(body),
      }),
      dbEnv,
      ctx,
    );
  }

  it('conflicts on a sign-up rather than handing back the existing account', async () => {
    const res = await post({ email: 'owner@shop.com', password: 'new-password-123' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { account?: unknown };
    expect(body.account).toBeUndefined();
  });

  it('still returns the existing account when no password is supplied (provisioning)', async () => {
    const res = await post({ email: 'owner@shop.com', shop_id: 'shop-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { id: string } };
    expect(body.account.id).toBe('acc-1');
  });
});

describe('/admin/accounts/verify-password', () => {
  it('requires admin auth', async () => {
    const res = await call(
      '/admin/accounts/verify-password',
      { method: 'POST', body: JSON.stringify({ email: 'a@b.com', password: 'x' }) },
      false,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a request missing email or password', async () => {
    const res = await call('/admin/accounts/verify-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('lets a well-formed request through to the DB', async () => {
    const res = await call('/admin/accounts/verify-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('buildAccountUpdate', () => {
  it('drops fields outside the whitelist', () => {
    const built = buildAccountUpdate({ google_sub: 'x', referral_code: 'nope', id: 'spoofed' });
    expect(built).toEqual({ update: { google_sub: 'x' } });
  });

  it('lets email_verified through', () => {
    const built = buildAccountUpdate({ email_verified: true });
    expect(built).toEqual({ update: { email_verified: true } });
  });

  it('drops a raw password_hash — only the route handler may set it, from a plaintext password', () => {
    const built = buildAccountUpdate({ password_hash: 'fake-hash-injected' });
    expect(built).toEqual({ error: 'No updatable fields provided' });
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

  it('lets a payout method and handle through, trimmed', () => {
    const built = buildAccountUpdate({ payout_method: 'venmo', payout_handle: ' @owner ' });
    expect(built).toEqual({ update: { payout_method: 'venmo', payout_handle: '@owner' } });
  });

  it('rejects an unknown payout method', () => {
    expect(buildAccountUpdate({ payout_method: 'bank' })).toEqual({
      error: 'invalid payout_method',
    });
  });

  it('rejects a blank payout handle', () => {
    expect(buildAccountUpdate({ payout_method: 'zelle', payout_handle: '   ' })).toEqual({
      error: 'payout_handle must be a non-empty string',
    });
  });
});
