import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import { buildShopCreate, buildShopUpdate } from '../../routes/admin';
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

function postShop(body: unknown, auth = true) {
  return worker.fetch(
    new Request('https://example.com/admin/shops', {
      method: 'POST',
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

const REQUIRED = {
  name: 'Salon',
  twilio_number: '+13055550100',
  escalation_phone: '+13055550111',
  owner_escalation_phone: '+13055550111',
  owner_email: 'owner@example.com',
};

// The exact key set landing's buildShopPayload sends. If create ever stops accepting one of these,
// provisioning fails at the last step — after the Twilio number has already been bought.
const PROVISIONING_PAYLOAD = {
  ...REQUIRED,
  transfers_enabled: false,
  service_catalog: [{ name: 'Full groom', duration_minutes: 180, price: 65, price_max: 135 }],
  timezone: 'America/New_York',
  hours_json: JSON.stringify({ Mon: '9:00am-7:00pm', Sun: 'closed' }),
  staff_json: JSON.stringify([{ id: 'stf_ana', name: 'Ana' }]),
  address: '1 Ocean Dr',
  notes: 'Street parking',
  integration: 'google_calendar',
  status: 'suspended',
  reminders_enabled: true,
  primary_language: 'es',
  elevenlabs_agent_id: 'agent_123',
};

describe('POST /admin/shops', () => {
  it('requires admin auth', async () => {
    const res = await postShop(REQUIRED, false);
    expect(res.status).toBe(401);
  });

  it('accepts a create with only the required fields (reaches the DB)', async () => {
    expect((await postShop(REQUIRED)).status).toBe(500);
  });

  it('accepts the payload landing provisioning sends (reaches the DB)', async () => {
    expect((await postShop(PROVISIONING_PAYLOAD)).status).toBe(500);
  });

  it('names the missing required field', async () => {
    const { name, ...withoutName } = REQUIRED;
    const res = await postShop(withoutName);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('name');
  });

  // The connect flow is the only writer of a calendar token. A create that could carry one would
  // hand a shop access to a calendar nobody granted it.
  it('refuses a create that carries a credentials blob', async () => {
    const res = await postShop({ ...REQUIRED, integration_credentials_encrypted: 'planted' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('integration_credentials_encrypted');
  });

  it('refuses a create that sets the id or created_at itself', async () => {
    for (const field of ['id', 'created_at']) {
      const res = await postShop({ ...REQUIRED, [field]: 'spoofed' });
      expect(res.status).toBe(400);
    }
  });

  it('names an unknown field rather than letting Postgres return a cast error', async () => {
    const res = await postShop({ ...REQUIRED, sms_enbaled: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('sms_enbaled');
  });

  // Until this packet a create stored hours PATCH would have refused, so a shop could be born with
  // opening times the agent cannot read.
  it('rejects on create the same malformed values PATCH rejects', async () => {
    expect((await postShop({ ...REQUIRED, hours_json: { Sat: '9-3' } })).status).toBe(400);
    expect((await postShop({ ...REQUIRED, closures_json: ['not-a-date'] })).status).toBe(400);
    expect(
      (await postShop({ ...REQUIRED, calendar_routing: { staff_calendars: {} } })).status,
    ).toBe(400);
    expect((await postShop({ ...REQUIRED, status: 'trial' })).status).toBe(400);
    expect((await postShop({ ...REQUIRED, is_demo: 'true' })).status).toBe(400);
    expect((await postShop({ ...REQUIRED, primary_language: 'pl' })).status).toBe(400);
  });
});

describe('buildShopCreate', () => {
  it('canonicalises staff so a shop has stable ids from its first second', () => {
    const built = buildShopCreate({ ...REQUIRED, staff_json: ['Ana', 'Luis'] });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    const staff = JSON.parse(built.row.staff_json as string) as Array<{ id: string; name: string }>;
    expect(staff.map((m) => m.name)).toEqual(['Ana', 'Luis']);
    expect(staff.every((m) => !!m.id)).toBe(true);
  });

  it('stores hours as the canonical JSON string, not the object it was given', () => {
    const built = buildShopCreate({ ...REQUIRED, hours_json: { 'Mon-Fri': '9am-7pm' } });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.row.hours_json).toBe('{"Mon-Fri":"9am-7pm"}');
  });

  // An empty string passes `MUTABLE_FIELDS.has`, so the required check has to be its own gate.
  it('treats an empty required field as missing', () => {
    expect('error' in buildShopCreate({ ...REQUIRED, owner_email: '' })).toBe(true);
  });

  it('keeps account_id available so a shop can be created against an account', () => {
    const built = buildShopCreate({ ...REQUIRED, account_id: 'acc-1' });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.row.account_id).toBe('acc-1');
  });
});

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
  it('accepts only boolean reminder settings', () => {
    expect(buildShopUpdate({ reminders_enabled: true })).toEqual({
      update: { reminders_enabled: true },
    });
    expect(buildShopUpdate({ reminders_enabled: false })).toEqual({
      update: { reminders_enabled: false },
    });
    expect('error' in buildShopUpdate({ reminders_enabled: 'yes' })).toBe(true);
  });

  it('accepts only boolean per-shop SMS approval', () => {
    expect(buildShopUpdate({ sms_enabled: true })).toEqual({ update: { sms_enabled: true } });
    expect(buildShopUpdate({ sms_enabled: false })).toEqual({ update: { sms_enabled: false } });
    expect('error' in buildShopUpdate({ sms_enabled: 'yes' })).toBe(true);
  });

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

  it('lets account_id through so a shop can be attached to an account', () => {
    const built = buildShopUpdate({ account_id: 'acc-1' });
    expect(built).toEqual({ update: { account_id: 'acc-1' } });
  });

  // is_demo decides whether a shop may hand a caller to a human. Set on a paying client by accident,
  // their callers stop reaching them and nothing in the logs says why — so it takes a real boolean.
  it('lets is_demo through as a boolean', () => {
    expect(buildShopUpdate({ is_demo: true })).toEqual({ update: { is_demo: true } });
    expect(buildShopUpdate({ is_demo: false })).toEqual({ update: { is_demo: false } });
  });

  it('rejects a non-boolean is_demo rather than coercing it', () => {
    for (const value of ['true', 'false', 1, 0, null]) {
      const built = buildShopUpdate({ is_demo: value });
      expect('error' in built).toBe(true);
    }
  });

  // Anything outside the CHECK in migration 0021 is a shop whose number the call lookups no longer
  // recognise: the line answers 404 and nothing in the logs says the status is why.
  it('lets every status the schema allows through', () => {
    for (const status of ['active', 'cancelled', 'suspended', 'demo']) {
      expect(buildShopUpdate({ status })).toEqual({ update: { status } });
    }
  });

  it('rejects a status the schema would refuse', () => {
    for (const status of ['trial', 'Demo', 'paused', '', 1, null]) {
      expect('error' in buildShopUpdate({ status })).toBe(true);
    }
  });
});
