import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import { buildShopUpdate } from '../../routes/admin';
import type { CalendarRouting, WorkerBindings } from '../../types';

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

  it('rejects staff_json that is not an array', async () => {
    const res = await patchShop({ staff_json: { name: 'Ana' } });
    expect(res.status).toBe(400);
  });

  it('rejects a staff member without a name', async () => {
    const res = await patchShop({ staff_json: [{ id: 'stf_x' }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('name');
  });

  it('rejects un-parseable staff hours', async () => {
    const res = await patchShop({ staff_json: [{ name: 'Luis', hours: { Tue: '9-5' } }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('staff_json');
  });

  it('accepts both the legacy and the object staff shape (reaches the DB)', async () => {
    expect((await patchShop({ staff_json: ['Ana', 'Luis'] })).status).toBe(500);
    expect(
      (await patchShop({ staff_json: [{ id: 'stf_a', name: 'Ana', hours: { Tue: '9am-5pm' } }] }))
        .status,
    ).toBe(500);
  });

  it('rejects calendar_routing without a write calendar', async () => {
    const res = await patchShop({ calendar_routing: { staff_calendars: {} } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('write_calendar_id');
  });
});

describe('buildShopUpdate', () => {
  it('canonicalises calendar_routing and keeps it an object for the jsonb column', () => {
    const built = buildShopUpdate({
      calendar_routing: {
        write_calendar_id: 'primary',
        staff_calendars: { stf_ana: 'c_ana@group.calendar.google.com' },
      },
    });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    const routing = built.update.calendar_routing as CalendarRouting;
    expect(routing.staff_calendars).toEqual({ stf_ana: 'c_ana@group.calendar.google.com' });
    expect(routing.busy_calendar_ids).toEqual([]);
    expect(routing.attribution).toEqual({ mode: 'off' });
  });

  it('rejects an unknown attribution mode', () => {
    const built = buildShopUpdate({
      calendar_routing: { write_calendar_id: 'primary', attribution: { mode: 'guess' } },
    });
    expect('error' in built).toBe(true);
  });

  it('clears both the credentials blob and the routing when the integration is dropped', () => {
    const built = buildShopUpdate({ integration: 'none' });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.update).toEqual({
      integration: 'none',
      integration_credentials_encrypted: null,
      calendar_routing: null,
    });
  });

  it('ignores fields outside the allowlist', () => {
    const built = buildShopUpdate({ id: 'spoofed', calendar_routing: null });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.update).toEqual({ calendar_routing: null });
  });
});
