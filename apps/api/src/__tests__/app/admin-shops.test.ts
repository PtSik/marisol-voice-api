import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import type { WorkerBindings } from '../../types';

// Empty SUPABASE_URL makes the DB call throw, so a request that reaches Supabase
// surfaces as a 500 — that lets us tell "passed validation" (reached DB → 500) from
// "blocked at validation" (400) without a live database.
const env = {
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_API_KEYS: 'testkey',
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function patchShop(body: unknown, auth = true) {
  return worker.fetch(
    new Request('https://example.com/admin/shops/abc', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer testkey' } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

describe('PATCH /admin/shops/:id', () => {
  it('requires admin auth', async () => {
    const res = await patchShop({ name: 'X' }, false);
    expect(res.status).toBe(401);
  });

  it('rejects hours_json with un-parseable hours', async () => {
    const res = await patchShop({ hours_json: { Sat: '9-3' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hours_json');
  });

  it('rejects closures_json that is not an array of dates', async () => {
    const res = await patchShop({ closures_json: ['not-a-date'] });
    expect(res.status).toBe(400);
  });

  it('rejects a body with no updatable fields', async () => {
    const res = await patchShop({ id: 'spoofed', created_at: 'x' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('accepts valid hours and closures (reaches the DB)', async () => {
    const res = await patchShop({
      hours_json: { 'Mon-Fri': '9am-7pm', Sat: '9am-3pm', Sun: 'closed' },
      closures_json: ['2026-12-25'],
    });
    expect(res.status).toBe(500);
  });
});
