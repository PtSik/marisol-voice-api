import { afterEach, describe, expect, it } from 'bun:test';
import {
  alertLines,
  classifyFailure,
  logGcalFailure,
  logGcalMoveConflict,
  runCalendarAlerts,
} from '../../lib/calendar-alerts';
import type { WorkerBindings } from '../../types';

function row(kind: string, shopId = 'shop_1', name = 'Bella Salon') {
  return {
    shop_id: shopId,
    payload: { op: 'busy', kind },
    shops: { name, status: 'active' },
  };
}

describe('classifyFailure', () => {
  it('treats a revoked grant or an auth rejection as permanent', () => {
    expect(classifyFailure('GCal OAuth refresh failed: invalid_grant')).toBe('auth');
    expect(classifyFailure('GCal events.list failed: 401')).toBe('auth');
  });

  it('treats timeouts and server errors as transient', () => {
    expect(classifyFailure('The operation timed out')).toBe('transient');
    expect(classifyFailure('GCal events.list failed: 503')).toBe('transient');
  });
});

describe('alertLines', () => {
  it('alerts on the first auth failure — a quiet shop would never reach a count threshold', () => {
    const alerts = alertLines([row('auth')]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('Bella Salon');
  });

  it('stays quiet for one or two transient failures', () => {
    expect(alertLines([row('transient'), row('transient')])).toEqual([]);
  });

  it('alerts once a shop crosses the transient threshold', () => {
    const alerts = alertLines([row('transient'), row('transient'), row('transient')]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.shopId).toBe('shop_1');
  });

  it('sends at most one alert per shop and counts shops separately', () => {
    const alerts = alertLines([
      row('auth'),
      row('auth'),
      row('transient'),
      row('transient', 'shop_2', 'Cortes'),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.shopId).toBe('shop_1');
  });

  it('ignores rows with no shop', () => {
    expect(alertLines([{ shop_id: null, payload: { kind: 'auth' }, shops: null }])).toEqual([]);
  });

  it('alerts on the first move conflict — calendar and register stay divorced until fixed', () => {
    const alerts = alertLines([
      { ...row('transient'), action: 'gcal_move_conflict', payload: { booking_id: 'bk_1' } },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('move');
  });

  it('reports a move conflict alongside failure alerts for the same shop', () => {
    const alerts = alertLines([
      { ...row('auth'), action: 'gcal_failure' },
      { ...row('transient'), action: 'gcal_move_conflict', payload: {} },
    ]);
    expect(alerts).toHaveLength(2);
  });
});

describe('runCalendarAlerts', () => {
  it('does nothing and does not throw when no Discord webhook is configured', async () => {
    const env = { SUPABASE_URL: '' } as unknown as WorkerBindings;
    expect(await runCalendarAlerts(env)).toEqual({ alerted: 0 });
  });
});

it('does not alert for inactive shops, including old logs after cancellation', () => {
  for (const status of ['suspended', 'cancelled', 'pending_review', undefined]) {
    expect(alertLines([{ ...row('auth'), shops: { name: 'Salon', status } }])).toEqual([]);
  }
});

// Migration 0024 drops audit_log.actor. Both writers must stop naming it, or every insert fails
// against the contracted schema — and these writes are best-effort, so the failure would be a
// console line and a missing Discord alert, not a visible error.
describe('audit_log writers after the schema contraction', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  } as WorkerBindings;

  function captureInsert(): { body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      captured = Array.isArray(parsed) ? parsed[0] : parsed;
      return new Response('[]', { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { body: () => captured };
  }

  it('logs a calendar failure without an actor', async () => {
    const insert = captureInsert();
    await logGcalFailure(env, 'shop_1', { op: 'busy', message: 'The operation timed out' });
    expect(insert.body()).toEqual({
      shop_id: 'shop_1',
      action: 'gcal_failure',
      payload: { op: 'busy', message: 'The operation timed out', kind: 'transient' },
    });
  });

  it('logs a move conflict without an actor', async () => {
    const insert = captureInsert();
    const payload = {
      booking_id: 'bk_1',
      calendar_id: 'c_main',
      start_at: '2026-09-22T15:00:00Z',
      end_at: '2026-09-22T16:00:00Z',
    };
    await logGcalMoveConflict(env, 'shop_1', payload);
    expect(insert.body()).toEqual({
      shop_id: 'shop_1',
      action: 'gcal_move_conflict',
      payload,
    });
  });
});
