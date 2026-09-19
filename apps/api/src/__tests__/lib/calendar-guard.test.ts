import { afterEach, describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkCalendarConflict } from '../../lib/calendar-guard';
import { encrypt } from '../../lib/crypto';
import type { StaffMember } from '../../lib/staff';
import type { CalendarRouting, ShopRow, WorkerBindings } from '../../types';

const env = { ENCRYPTION_KEY: 'a'.repeat(64) } as WorkerBindings;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ANA: StaffMember = { id: 'stf_ana', name: 'Ana' };
const ROSTER: StaffMember[] = [ANA, { id: 'stf_luis', name: 'Luis' }];

const SLOT_START = '2026-07-23T09:00:00.000Z';
const SLOT_END = '2026-07-23T10:00:00.000Z';

async function connectedShop(routing: Partial<CalendarRouting> = {}): Promise<ShopRow> {
  const creds = await encrypt(
    JSON.stringify({ type: 'oauth', refresh_token: 'rt-guard' }),
    env.ENCRYPTION_KEY,
  );
  return {
    id: 'shop_1',
    integration: 'google_calendar',
    integration_credentials_encrypted: creds,
    staff_json: JSON.stringify(ROSTER),
    calendar_routing: {
      write_calendar_id: 'c_main',
      staff_calendars: {},
      busy_calendar_ids: [],
      attribution: { mode: 'off' },
      ...routing,
    },
  } as unknown as ShopRow;
}

// An event overlapping the slot under test unless told otherwise.
const event = (id: string, opts: { title?: string; colorId?: string; hour?: number } = {}) => ({
  id,
  summary: opts.title,
  colorId: opts.colorId,
  start: { dateTime: `2026-07-23T${String(opts.hour ?? 9).padStart(2, '0')}:00:00Z` },
  end: { dateTime: `2026-07-23T${String((opts.hour ?? 9) + 1).padStart(2, '0')}:00:00Z` },
});

function mockCalendars(byCalendar: Record<string, unknown[]>) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    const calendarId = decodeURIComponent(/calendars\/([^/]+)\/events/.exec(url)?.[1] ?? '');
    const items = byCalendar[calendarId];
    if (!items) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as unknown as typeof fetch;
}

// Minimal stand-in for the one query the guard runs: bookings overlapping the slot.
function fakeDb(rows: Array<{ gcal_event_id: string | null }> | { error: true }) {
  const result =
    'error' in rows
      ? { data: null, error: { message: 'connection failure' } }
      : { data: rows, error: null };
  // `.gt()` is the last call the guard chains, so it stands in for the awaited result.
  const builder = {
    select: () => builder,
    eq: () => builder,
    lt: () => builder,
    gt: () => Promise.resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const guard = (
  shop: ShopRow,
  db: SupabaseClient,
  extra: { member?: StaffMember; ignoreEventIds?: string[] } = {},
) =>
  checkCalendarConflict(env, db, shop, {
    startAt: SLOT_START,
    endAt: SLOT_END,
    member: 'member' in extra ? extra.member : ANA,
    roster: ROSTER,
    ...(extra.ignoreEventIds ? { ignoreEventIds: extra.ignoreEventIds } : {}),
    waitUntil: () => {},
  });

describe('checkCalendarConflict', () => {
  it('blocks on a foreign event in the shared calendar', async () => {
    mockCalendars({ c_main: [event('booksy_1')] });
    expect(await guard(await connectedShop(), fakeDb([]))).toBe('blocked');
  });

  it("blocks on a foreign event in the slot owner's own calendar", async () => {
    const shop = await connectedShop({ staff_calendars: { stf_ana: 'c_ana' } });
    mockCalendars({ c_main: [], c_ana: [event('ana_dentist')] });
    expect(await guard(shop, fakeDb([]))).toBe('blocked');
  });

  it("ignores a foreign event in a different person's calendar", async () => {
    const shop = await connectedShop({
      staff_calendars: { stf_ana: 'c_ana', stf_luis: 'c_luis' },
    });
    mockCalendars({ c_main: [], c_ana: [], c_luis: [event('luis_dentist')] });
    expect(await guard(shop, fakeDb([]))).toBe('clear');
  });

  it('does not let our own mirrored event in the shared calendar block us', async () => {
    mockCalendars({ c_main: [event('ours_1')] });
    expect(await guard(await connectedShop(), fakeDb([{ gcal_event_id: 'ours_1' }]))).toBe('clear');
  });

  // The correction S3 makes: booking used to filter own events out of the shared calendar only,
  // so its own mirror sitting in a per-staff calendar refused the slot the DB already owns.
  it('does not let our own mirrored event in a per-staff calendar block us', async () => {
    const shop = await connectedShop({ staff_calendars: { stf_ana: 'c_ana' } });
    mockCalendars({ c_main: [], c_ana: [event('ours_2')] });
    expect(await guard(shop, fakeDb([{ gcal_event_id: 'ours_2' }]))).toBe('clear');
  });

  // Reschedule's case: moving to a slot that does not overlap the old one means the DB overlap
  // query never returns this booking, so only ignoreEventIds can keep it from blocking itself.
  it('excludes the rescheduled booking even when the DB query cannot see it', async () => {
    mockCalendars({ c_main: [event('current_booking')] });
    const db = fakeDb([]);
    expect(await guard(await connectedShop(), db)).toBe('blocked');
    expect(await guard(await connectedShop(), db, { ignoreEventIds: ['current_booking'] })).toBe(
      'clear',
    );
  });

  it('reports unavailable when the bookings read fails', async () => {
    mockCalendars({ c_main: [] });
    expect(await guard(await connectedShop(), fakeDb({ error: true }))).toBe('unavailable');
  });

  it('reports unavailable when a calendar read fails, rather than calling the slot free', async () => {
    const shop = await connectedShop({ staff_calendars: { stf_ana: 'c_ana' } });
    // c_ana is absent from the mock, so its read errors.
    mockCalendars({ c_main: [] });
    expect(await guard(shop, fakeDb([]))).toBe('unavailable');
  });

  it('attributes a titled shared event to its owner, blocking only them', async () => {
    const shop = await connectedShop({ attribution: { mode: 'title_prefix' } });
    mockCalendars({ c_main: [event('luis_cut', { title: 'Luis: fade' })] });

    expect(await guard(shop, fakeDb([]), { member: ANA })).toBe('clear');
    expect(await guard(shop, fakeDb([]), { member: ROSTER[1] })).toBe('blocked');
  });

  it('still blocks everyone when attribution cannot place a shared event', async () => {
    const shop = await connectedShop({ attribution: { mode: 'title_prefix' } });
    mockCalendars({ c_main: [event('unknown', { title: 'Deep clean' })] });
    expect(await guard(shop, fakeDb([]), { member: ANA })).toBe('blocked');
  });

  it('is clear when nothing overlaps the slot', async () => {
    mockCalendars({ c_main: [event('later', { hour: 14 })] });
    expect(await guard(await connectedShop(), fakeDb([]))).toBe('clear');
  });
});
