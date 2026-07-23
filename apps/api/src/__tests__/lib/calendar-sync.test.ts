import { afterEach, describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyDelta,
  planDeltaAction,
  repairBooking,
  syncCalendar,
  syncCalendarsFor,
} from '../../lib/calendar-sync';
import { deterministicEventId } from '../../lib/gcal';
import type { BookingRow, CalendarRouting, ShopRow, WorkerBindings } from '../../types';

const booking = {
  status: 'confirmed',
  start_at: '2026-07-23T15:00:00+00:00',
  end_at: '2026-07-23T15:30:00+00:00',
};

describe('planDeltaAction', () => {
  it('cancels a confirmed booking when its event was deleted', () => {
    expect(planDeltaAction(booking, { id: 'e1', status: 'cancelled' })).toEqual({
      type: 'cancel',
    });
  });

  it('does nothing when the booking is already cancelled — echo of our own delete', () => {
    expect(
      planDeltaAction({ ...booking, status: 'cancelled' }, { id: 'e1', status: 'cancelled' }),
    ).toEqual({ type: 'none' });
  });

  it('moves the booking when the event times changed', () => {
    const action = planDeltaAction(booking, {
      id: 'e1',
      status: 'confirmed',
      start: { dateTime: '2026-07-23T16:00:00Z' },
      end: { dateTime: '2026-07-23T16:30:00Z' },
    });
    expect(action).toEqual({
      type: 'move',
      startIso: '2026-07-23T16:00:00.000Z',
      endIso: '2026-07-23T16:30:00.000Z',
    });
  });

  it('suppresses the echo of our own write, offset notation notwithstanding', () => {
    const action = planDeltaAction(booking, {
      id: 'e1',
      status: 'confirmed',
      start: { dateTime: '2026-07-23T17:00:00+02:00' },
      end: { dateTime: '2026-07-23T17:30:00+02:00' },
    });
    expect(action).toEqual({ type: 'none' });
  });

  it('never moves a booking that is not confirmed', () => {
    const action = planDeltaAction(
      { ...booking, status: 'cancelled' },
      {
        id: 'e1',
        status: 'confirmed',
        start: { dateTime: '2026-07-23T16:00:00Z' },
        end: { dateTime: '2026-07-23T16:30:00Z' },
      },
    );
    expect(action).toEqual({ type: 'none' });
  });

  it('ignores an event converted to all-day — no usable times', () => {
    const action = planDeltaAction(booking, {
      id: 'e1',
      status: 'confirmed',
      start: { date: '2026-07-23' },
      end: { date: '2026-07-24' },
    });
    expect(action).toEqual({ type: 'none' });
  });

  it('ignores a confirmed delta with no times at all', () => {
    expect(planDeltaAction(booking, { id: 'e1', status: 'confirmed' })).toEqual({ type: 'none' });
  });
});

describe('syncCalendarsFor', () => {
  const routing: CalendarRouting = {
    write_calendar_id: 'c_main',
    staff_calendars: { stf_ana: 'c_ana', stf_luis: 'c_main' },
    busy_calendar_ids: ['c_holidays'],
    attribution: { mode: 'off' },
  };

  it('covers write and staff calendars once each, skipping busy-only calendars', () => {
    expect(syncCalendarsFor(routing, [])).toEqual(['c_main', 'c_ana']);
  });

  it('keeps a calendar that bookings were written to before the mapping changed', () => {
    expect(syncCalendarsFor(routing, ['c_old', 'c_main', null])).toEqual([
      'c_main',
      'c_ana',
      'c_old',
    ]);
  });
});

describe('deterministicEventId', () => {
  it('strips dashes from the booking id so the result fits base32hex', () => {
    const id = deterministicEventId('D9428888-122B-11E1-B85C-61CD3CBB3210');
    expect(id).toBe('d9428888122b11e1b85c61cd3cbb3210');
    expect(id).toMatch(/^[0-9a-v]{32}$/);
  });
});

// In-memory Supabase stub — emulates the PostgREST builder chains this module uses:
//   .select().eq().in() · .update().eq()… .select() · .upsert()
type DbError = { code?: string; message: string } | null;
type DbResult = { data?: unknown; error?: DbError };

interface DbCall {
  table: string;
  op: 'select' | 'update' | 'upsert';
  payload?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

interface Builder extends PromiseLike<DbResult> {
  select(cols?: string): Builder;
  update(payload: Record<string, unknown>): Builder;
  upsert(payload: Record<string, unknown>): Builder;
  eq(col: string, val: unknown): Builder;
  in(col: string, val: unknown[]): Builder;
  gte(col: string, val: unknown): Builder;
  lt(col: string, val: unknown): Builder;
  not(col: string, op: string, val: unknown): Builder;
}

function makeDb(handler: (call: DbCall) => DbResult) {
  const calls: DbCall[] = [];
  const client = {
    from(table: string): Builder {
      const call: DbCall = { table, op: 'select', filters: [] };
      const filter = (op: string) => (col: string, val: unknown) => {
        call.filters.push([op, col, val]);
        return builder;
      };
      const builder: Builder = {
        select: () => builder,
        update: (payload) => {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        upsert: (payload) => {
          call.op = 'upsert';
          call.payload = payload;
          return builder;
        },
        eq: filter('eq'),
        in: filter('in'),
        gte: filter('gte'),
        lt: filter('lt'),
        not: (col, op, val) => {
          call.filters.push([`not.${op}`, col, val]);
          return builder;
        },
        // biome-ignore lint/suspicious/noThenProperty: stub emulates an awaitable PostgREST builder
        then: (resolve, reject) => {
          calls.push(call);
          return Promise.resolve(handler(call)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db: client as unknown as SupabaseClient, calls };
}

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
} as unknown as WorkerBindings;

const shop = {
  id: 'shop_1',
  timezone: 'America/New_York',
  staff_json: [],
  calendar_routing: {
    write_calendar_id: 'c_main',
    staff_calendars: {},
    busy_calendar_ids: [],
    attribution: { mode: 'off' },
  },
} as unknown as ShopRow;

function makeBooking(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    shop_id: 'shop_1',
    customer_phone: '+15550001111',
    customer_name: 'Ana',
    staff: 'Luis',
    service: 'Haircut',
    start_at: '2026-07-23T15:00:00+00:00',
    end_at: '2026-07-23T15:30:00+00:00',
    status: 'confirmed',
    gcal_event_id: null,
    gcal_calendar_id: null,
    cancelled_via: null,
    gcal_sync_pending: true,
    ...overrides,
  } as BookingRow;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Records every outbound call so a test can assert what did — and did not — reach Google.
function mockFetch(
  routes: Array<{ match: RegExp; method?: string; status: number; body?: unknown }>,
) {
  const seen: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push({ url, method });
    const route = routes.find((r) => r.match.test(url) && (!r.method || r.method === method));
    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

describe('applyDelta', () => {
  const booking = makeBooking();

  it('cancels the booking and reports it applied', async () => {
    const { db, calls } = makeDb(() => ({ data: [{ id: booking.id }], error: null }));
    const outcome = await applyDelta(env, db, shop, 'c_main', booking, { type: 'cancel' });
    expect(outcome).toBe('applied');
    expect(calls[0]?.payload).toMatchObject({ status: 'cancelled', cancelled_via: 'calendar' });
  });

  // The compare-and-set runs on every field we read, so a fresher phone change wins.
  it('skips — never fails — when the compare-and-set loses the race', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }));
    expect(await applyDelta(env, db, shop, 'c_main', booking, { type: 'cancel' })).toBe('skipped');
  });

  // The distinction matters: 'failed' is what holds the sync token back.
  it('reports a write error as failed so the sync token cannot advance past it', async () => {
    const { db } = makeDb(() => ({ error: { code: '08006', message: 'connection failure' } }));
    expect(await applyDelta(env, db, shop, 'c_main', booking, { type: 'cancel' })).toBe('failed');
  });

  it('applies a move', async () => {
    const { db, calls } = makeDb(() => ({ data: [{ id: booking.id }], error: null }));
    const outcome = await applyDelta(env, db, shop, 'c_main', booking, {
      type: 'move',
      startIso: '2026-07-23T16:00:00.000Z',
      endIso: '2026-07-23T16:30:00.000Z',
    });
    expect(outcome).toBe('applied');
    expect(calls[0]?.payload).toMatchObject({ start_at: '2026-07-23T16:00:00.000Z' });
  });

  // A GiST rejection is a deliberate refusal, not a failure — it is logged and alerted, and
  // retrying it next tick would only produce the same conflict.
  it('skips a move that collides and records gcal_move_conflict', async () => {
    mockFetch([{ match: /audit_log/, status: 201 }]);
    const { db } = makeDb(() => ({ error: { code: '23P01', message: 'exclusion violation' } }));
    const outcome = await applyDelta(env, db, shop, 'c_main', booking, {
      type: 'move',
      startIso: '2026-07-23T16:00:00.000Z',
      endIso: '2026-07-23T16:30:00.000Z',
    });
    expect(outcome).toBe('skipped');
  });
});

describe('syncCalendar token handling', () => {
  const booking = makeBooking({ gcal_event_id: 'evt_1' });
  const deltaPage = {
    nextSyncToken: 'tok_next',
    items: [{ id: 'evt_1', status: 'cancelled' }],
  };

  it('stores the next sync token once every delta settled', async () => {
    mockFetch([{ match: /calendar\/v3/, status: 200, body: deltaPage }]);
    const { db, calls } = makeDb((call) =>
      call.op === 'update'
        ? { data: [{ id: booking.id }], error: null }
        : { data: [booking], error: null },
    );
    await syncCalendar(env, db, shop, 'token', 'c_main', 'tok_old', Date.now());
    const upsert = calls.find((c) => c.table === 'calendar_sync_state' && c.op === 'upsert');
    expect(upsert?.payload).toMatchObject({ calendar_id: 'c_main', sync_token: 'tok_next' });
  });

  // Google never replays a consumed delta — advancing the token here would lose the
  // cancellation for good and leave the slot blocked with nobody the wiser.
  it('holds the token back when a delta failed to apply', async () => {
    mockFetch([{ match: /calendar\/v3/, status: 200, body: deltaPage }]);
    const { db, calls } = makeDb((call) =>
      call.op === 'update'
        ? { error: { code: '08006', message: 'connection failure' } }
        : { data: [booking], error: null },
    );
    await syncCalendar(env, db, shop, 'token', 'c_main', 'tok_old', Date.now());
    expect(calls.find((c) => c.table === 'calendar_sync_state')).toBeUndefined();
  });

  it('restarts from scratch when the stored token expired with a 410', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      return call === 1
        ? new Response('{}', { status: 410 })
        : new Response(JSON.stringify({ nextSyncToken: 'tok_fresh', items: [] }), { status: 200 });
    }) as typeof fetch;
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await syncCalendar(env, db, shop, 'token', 'c_main', 'tok_stale', Date.now());
    const upsert = calls.find((c) => c.table === 'calendar_sync_state');
    expect(upsert?.payload).toMatchObject({ sync_token: 'tok_fresh' });
  });
});

describe('repairBooking', () => {
  it('creates the missing event and stores both the id and the calendar', async () => {
    const booking = makeBooking();
    const eventId = deterministicEventId(booking.id);
    mockFetch([{ match: /events/, method: 'POST', status: 200, body: { id: eventId } }]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(calls[0]?.payload).toMatchObject({
      gcal_event_id: eventId,
      gcal_calendar_id: 'c_main',
      gcal_sync_pending: false,
    });
  });

  // 409 means the id is taken — by our own earlier create, whose response we lost.
  it('adopts the event when a 409 turns out to be a live event', async () => {
    const booking = makeBooking();
    const eventId = deterministicEventId(booking.id);
    mockFetch([
      { match: /events/, method: 'POST', status: 409 },
      { match: /events/, method: 'GET', status: 200, body: { id: eventId, status: 'confirmed' } },
    ]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ gcal_event_id: eventId, gcal_sync_pending: false });
  });

  // Google keeps a deleted id forever as 'cancelled', so this 409 is a human cancellation.
  it('never resurrects an event the owner already deleted', async () => {
    const booking = makeBooking();
    const eventId = deterministicEventId(booking.id);
    const seen = mockFetch([
      { match: /events/, method: 'POST', status: 409 },
      { match: /events/, method: 'GET', status: 200, body: { id: eventId, status: 'cancelled' } },
    ]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(calls[0]?.payload).toMatchObject({
      status: 'cancelled',
      cancelled_via: 'calendar',
      gcal_sync_pending: false,
    });
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
  });

  it('patches an existing event to the times held in the register', async () => {
    const booking = makeBooking({ gcal_event_id: 'evt_1', gcal_calendar_id: 'c_main' });
    const seen = mockFetch([{ match: /events/, method: 'PATCH', status: 200 }]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(seen.some((s) => s.method === 'PATCH')).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ gcal_sync_pending: false });
  });

  // Without this branch the flag stays up forever and the shop gets an alert every hour.
  it('treats a patch onto a deleted event as the owner cancelling', async () => {
    const booking = makeBooking({ gcal_event_id: 'evt_1', gcal_calendar_id: 'c_main' });
    mockFetch([
      { match: /events/, method: 'PATCH', status: 410 },
      { match: /events/, method: 'GET', status: 200, body: { id: 'evt_1', status: 'cancelled' } },
    ]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(calls[0]?.payload).toMatchObject({
      status: 'cancelled',
      cancelled_via: 'calendar',
      gcal_sync_pending: false,
    });
  });

  // A 404 with no event behind it means the id was never in *this* calendar — the routing
  // moved. Drop the stale pointer and let the next tick create it where routing points now.
  it('clears a stale pointer when the event is in no calendar we know', async () => {
    const booking = makeBooking({ gcal_event_id: 'evt_1', gcal_calendar_id: 'c_old' });
    mockFetch([
      { match: /events/, method: 'PATCH', status: 404 },
      { match: /events/, method: 'GET', status: 404 },
    ]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(false);
    expect(calls[0]?.payload).toMatchObject({ gcal_event_id: null, gcal_calendar_id: null });
  });

  it('deletes the event of a cancelled booking and drops the id', async () => {
    const booking = makeBooking({
      status: 'cancelled',
      gcal_event_id: 'evt_1',
      gcal_calendar_id: 'c_main',
    });
    const seen = mockFetch([{ match: /events/, method: 'DELETE', status: 204 }]);
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await repairBooking(env, db, shop, 'token', booking)).toBe(true);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ gcal_event_id: null, gcal_sync_pending: false });
  });
});
