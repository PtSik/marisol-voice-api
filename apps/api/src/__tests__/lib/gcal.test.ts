import { afterEach, describe, expect, it } from 'bun:test';
import { encrypt } from '../../lib/crypto';
import {
  GCalHttpError,
  canWriteTo,
  gcalCreateEvent,
  gcalDeleteEvent,
  gcalGetEvent,
  gcalListBusy,
  gcalListCalendars,
  gcalListDeltas,
  getStaffBusy,
  resolveRouting,
  writeCalendarFor,
} from '../../lib/gcal';
import type { CalendarRouting, ShopRow, WorkerBindings } from '../../types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('gcalListBusy', () => {
  it('keeps busy events, drops cancelled + transparent, parses timed and all-day', async () => {
    mockFetch(200, {
      items: [
        {
          id: 'a',
          start: { dateTime: '2026-07-10T09:00:00Z' },
          end: { dateTime: '2026-07-10T10:00:00Z' },
        },
        {
          id: 'b',
          status: 'cancelled',
          start: { dateTime: '2026-07-10T11:00:00Z' },
          end: { dateTime: '2026-07-10T12:00:00Z' },
        },
        {
          id: 'c',
          transparency: 'transparent',
          start: { dateTime: '2026-07-10T13:00:00Z' },
          end: { dateTime: '2026-07-10T14:00:00Z' },
        },
        { id: 'd', start: { date: '2026-07-11' }, end: { date: '2026-07-12' } },
        { id: 'e', start: {}, end: {} },
      ],
    });
    const busy = await gcalListBusy(
      'primary',
      'tok',
      '2026-07-10T00:00:00Z',
      '2026-07-13T00:00:00Z',
    );
    expect(busy.map((b) => b.id)).toEqual(['a', 'd']);
    expect(busy[0]).toEqual({
      id: 'a',
      start: Date.parse('2026-07-10T09:00:00Z'),
      end: Date.parse('2026-07-10T10:00:00Z'),
    });
  });

  it('throws on a non-ok response', async () => {
    mockFetch(500, {});
    await expect(gcalListBusy('primary', 'tok', 'a', 'b')).rejects.toThrow();
  });
});

describe('getStaffBusy', () => {
  const env = { ENCRYPTION_KEY: 'a'.repeat(64), SUPABASE_URL: '' } as WorkerBindings;

  it('returns nothing when the shop has no google_calendar integration', async () => {
    const shop = {
      integration: 'none',
      integration_credentials_encrypted: null,
    } as unknown as ShopRow;
    expect(await getStaffBusy(env, shop, 'a', 'b')).toEqual({ shared: [], perStaff: {} });
  });

  it('marks availability unknown when credentials cannot be decrypted', async () => {
    const shop = {
      integration: 'google_calendar',
      integration_credentials_encrypted: 'not-valid-creds',
    } as unknown as ShopRow;
    expect(await getStaffBusy(env, shop, 'a', 'b')).toEqual({
      shared: [],
      perStaff: {},
      unavailable: true,
    });
  });

  async function connectedShop(routing: Partial<CalendarRouting>): Promise<ShopRow> {
    const creds = await encrypt(
      JSON.stringify({ type: 'oauth', refresh_token: `rt-${Math.random()}` }),
      env.ENCRYPTION_KEY,
    );
    return {
      id: 'shop_1',
      integration: 'google_calendar',
      integration_credentials_encrypted: creds,
      calendar_routing: {
        write_calendar_id: 'c_main',
        staff_calendars: {},
        busy_calendar_ids: [],
        attribution: { mode: 'off' },
        ...routing,
      },
    } as unknown as ShopRow;
  }

  // Each calendar answers on its own; anything not listed rejects, standing in for a
  // calendar that errors or runs past the deadline.
  function mockCalendars(byCalendar: Record<string, unknown[]>) {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
        });
      }
      const match = /calendars\/([^/]+)\/events/.exec(url);
      const calendarId = decodeURIComponent(match?.[1] ?? '');
      const items = byCalendar[calendarId];
      if (!items) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ items }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  const event = (id: string, hour: number) => ({
    id,
    start: { dateTime: `2026-07-23T${String(hour).padStart(2, '0')}:00:00Z` },
    end: { dateTime: `2026-07-23T${String(hour + 1).padStart(2, '0')}:00:00Z` },
  });

  it('splits shared calendars from per-staff ones', async () => {
    const shop = await connectedShop({
      staff_calendars: { stf_ana: 'c_ana' },
      busy_calendar_ids: ['c_holidays'],
    });
    mockCalendars({
      c_main: [event('main1', 9)],
      c_ana: [event('ana1', 11)],
      c_holidays: [event('hol1', 13)],
    });
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(busy.shared.map((b) => b.id).sort()).toEqual(['hol1', 'main1']);
    expect(busy.perStaff.stf_ana?.map((b) => b.id)).toEqual(['ana1']);
  });

  it('keeps the calendars that answered when one of them fails', async () => {
    const shop = await connectedShop({ staff_calendars: { stf_ana: 'c_ana' } });
    mockCalendars({ c_main: [event('main1', 9)] });
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(busy.shared.map((b) => b.id)).toEqual(['main1']);
    expect(busy.perStaff.stf_ana).toBeUndefined();
    expect(busy.unavailable).toBe(true);
  });

  it('treats a staff calendar that is also the write calendar as shared', async () => {
    const shop = await connectedShop({ staff_calendars: { stf_ana: 'c_main' } });
    mockCalendars({ c_main: [event('main1', 9)] });
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(busy.shared.map((b) => b.id)).toEqual(['main1']);
    expect(busy.perStaff).toEqual({});
  });

  it('keeps the default write calendar per-person when every team member has a calendar', async () => {
    const shop = await connectedShop({
      staff_calendars: { stf_ana: 'c_main', stf_luis: 'c_luis' },
    });
    shop.staff_json = JSON.stringify([
      { id: 'stf_ana', name: 'Ana' },
      { id: 'stf_luis', name: 'Luis' },
    ]);
    mockCalendars({ c_main: [event('ana1', 9)], c_luis: [] });
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(busy.shared).toEqual([]);
    expect(busy.perStaff.stf_ana?.map((b) => b.id)).toEqual(['ana1']);
    expect(busy.perStaff.stf_luis).toEqual([]);
  });

  it('keeps a staff calendar per-person even when a legacy config also lists it as busy', async () => {
    const shop = await connectedShop({
      staff_calendars: { stf_ana: 'c_ana' },
      busy_calendar_ids: ['c_ana', 'c_holidays'],
    });
    mockCalendars({
      c_main: [event('main1', 9)],
      c_ana: [event('ana1', 11)],
      c_holidays: [event('hol1', 13)],
    });
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(busy.shared.map((b) => b.id).sort()).toEqual(['hol1', 'main1']);
    expect(busy.perStaff.stf_ana?.map((b) => b.id)).toEqual(['ana1']);
  });

  it('reads a calendar shared by two staff members once and gives both the result', async () => {
    const shop = await connectedShop({
      staff_calendars: { stf_ana: 'c_chair', stf_luis: 'c_chair' },
    });
    let calls = 0;
    mockCalendars({ c_main: [], c_chair: [event('chair1', 9)] });
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/events')) calls++;
      return mocked(input as string, init);
    }) as unknown as typeof fetch;
    const busy = await getStaffBusy(env, shop, 'a', 'b');
    expect(calls).toBe(2); // c_main + c_chair, not one per staff member
    expect(busy.perStaff.stf_ana?.map((b) => b.id)).toEqual(['chair1']);
    expect(busy.perStaff.stf_luis?.map((b) => b.id)).toEqual(['chair1']);
  });

  it('marks availability unknown when the token exchange runs past the deadline', async () => {
    const shop = await connectedShop({});
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const busy = await getStaffBusy(env, shop, 'a', 'b', { timeoutMs: 60 });
    expect(busy).toEqual({ shared: [], perStaff: {}, unavailable: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('resolveRouting', () => {
  it('gives a shop that never used the picker todays single-calendar behaviour', () => {
    const routing = resolveRouting({ calendar_routing: null } as unknown as ShopRow);
    expect(routing).toEqual({
      write_calendar_id: 'primary',
      staff_calendars: {},
      busy_calendar_ids: [],
      attribution: { mode: 'off' },
    });
  });

  it('fills in the parts a partially written routing is missing', () => {
    const shop = {
      calendar_routing: { write_calendar_id: 'c_main@group.calendar.google.com' },
    } as unknown as ShopRow;
    const routing = resolveRouting(shop);
    expect(routing.write_calendar_id).toBe('c_main@group.calendar.google.com');
    expect(routing.staff_calendars).toEqual({});
    expect(routing.attribution.mode).toBe('off');
  });

  it('keeps a full routing as written', () => {
    const stored: CalendarRouting = {
      write_calendar_id: 'c_main',
      staff_calendars: { stf_ana: 'c_ana' },
      busy_calendar_ids: ['c_holidays'],
      attribution: { mode: 'color', colors: { '5': 'stf_ana' } },
    };
    expect(resolveRouting({ calendar_routing: stored } as unknown as ShopRow)).toEqual(stored);
  });
});

describe('writeCalendarFor', () => {
  const shop = {
    calendar_routing: {
      write_calendar_id: 'c_main',
      staff_calendars: { stf_ana: 'c_ana' },
      busy_calendar_ids: [],
      attribution: { mode: 'off' },
    },
  } as unknown as ShopRow;

  it('writes to the staff calendar when one is mapped', () => {
    expect(writeCalendarFor(shop, 'stf_ana')).toBe('c_ana');
  });

  it('falls back to the main calendar for unmapped or unknown staff', () => {
    expect(writeCalendarFor(shop, 'stf_luis')).toBe('c_main');
    expect(writeCalendarFor(shop)).toBe('c_main');
  });

  it('writes to primary for a shop that never used the picker', () => {
    expect(writeCalendarFor({ calendar_routing: null } as unknown as ShopRow, 'stf_ana')).toBe(
      'primary',
    );
  });
});

describe('gcalListCalendars', () => {
  it('maps the list and prefers the user override for the name', async () => {
    mockFetch(200, {
      items: [
        { id: 'primary@example.com', summary: 'Owner', accessRole: 'owner', primary: true },
        { id: 'c_ana', summary: 'Ana', summaryOverride: 'Ana — chair 2', accessRole: 'writer' },
        { id: 'c_shared', accessRole: 'freeBusyReader' },
      ],
    });
    const calendars = await gcalListCalendars('tok');
    expect(calendars).toEqual([
      { id: 'primary@example.com', summary: 'Owner', accessRole: 'owner', primary: true },
      { id: 'c_ana', summary: 'Ana — chair 2', accessRole: 'writer', primary: false },
      { id: 'c_shared', summary: 'c_shared', accessRole: 'freeBusyReader', primary: false },
    ]);
    expect(calendars.filter(canWriteTo).map((c) => c.id)).toEqual(['primary@example.com', 'c_ana']);
  });

  it('throws on a non-ok response', async () => {
    mockFetch(403, {});
    await expect(gcalListCalendars('tok')).rejects.toThrow();
  });
});

describe('gcalCreateEvent', () => {
  it('tags the event with the booking id so a later sync can map it back', async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const id = await gcalCreateEvent(
      'c_ana',
      'tok',
      'Cut — Bob (Ana)',
      'Phone: +1',
      '2026-07-23T15:00:00Z',
      '2026-07-23T15:30:00Z',
      'America/New_York',
      'bk_1',
    );
    expect(id).toBe('evt_1');
    expect(sent.extendedProperties).toEqual({ private: { marisol_booking_id: 'bk_1' } });
  });

  it('omits extendedProperties when no booking id is given', async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'evt_2' }), { status: 200 });
    }) as unknown as typeof fetch;
    await gcalCreateEvent('primary', 'tok', 's', 'd', 'a', 'b', 'UTC');
    expect(sent.extendedProperties).toBeUndefined();
  });

  it('sends a client-supplied event id and surfaces a collision as a typed 409', async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response('{}', { status: 409 });
    }) as unknown as typeof fetch;
    const err = await gcalCreateEvent(
      'primary',
      'tok',
      's',
      'd',
      'a',
      'b',
      'UTC',
      'bk_1',
      'abc123',
    ).catch((e) => e);
    expect(sent.id).toBe('abc123');
    expect(err).toBeInstanceOf(GCalHttpError);
    expect((err as GCalHttpError).status).toBe(409);
  });
});

describe('gcalGetEvent', () => {
  it('returns the event snapshot', async () => {
    mockFetch(200, { id: 'evt_1', status: 'cancelled' });
    expect(await gcalGetEvent('primary', 'tok', 'evt_1')).toEqual({
      id: 'evt_1',
      status: 'cancelled',
    });
  });

  it('returns null for an event that never existed', async () => {
    mockFetch(404, {});
    expect(await gcalGetEvent('primary', 'tok', 'nope')).toBeNull();
  });
});

describe('gcalDeleteEvent', () => {
  it('treats an already-gone event as success', async () => {
    mockFetch(404, {});
    await gcalDeleteEvent('primary', 'tok', 'nope');
    mockFetch(410, {});
    await gcalDeleteEvent('primary', 'tok', 'gone');
  });
});

describe('gcalListDeltas', () => {
  function captureUrl(status: number, body: unknown): { url: () => string } {
    let captured = '';
    globalThis.fetch = (async (input: string | URL) => {
      captured = String(input);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { url: () => captured };
  }

  it('first sync passes timeMin and the fixed sync parameters', async () => {
    const req = captureUrl(200, { items: [], nextSyncToken: 'st_1' });
    const page = await gcalListDeltas('primary', 'tok', { timeMinIso: '2026-07-22T12:00:00Z' });
    const params = new URL(req.url()).searchParams;
    expect(params.get('timeMin')).toBe('2026-07-22T12:00:00Z');
    expect(params.get('singleEvents')).toBe('false');
    expect(params.get('showDeleted')).toBe('true');
    expect(params.get('syncToken')).toBeNull();
    expect(page.nextSyncToken).toBe('st_1');
  });

  it('incremental sync passes the token and never timeMin — they are incompatible', async () => {
    const req = captureUrl(200, { items: [], nextSyncToken: 'st_2' });
    await gcalListDeltas('primary', 'tok', { syncToken: 'st_1', timeMinIso: 'ignored' });
    const params = new URL(req.url()).searchParams;
    expect(params.get('syncToken')).toBe('st_1');
    expect(params.get('timeMin')).toBeNull();
  });

  it('maps the booking id out of extendedProperties and keeps skeleton deltas', async () => {
    captureUrl(200, {
      items: [
        {
          id: 'evt_1',
          status: 'confirmed',
          start: { dateTime: '2026-07-23T15:00:00Z' },
          end: { dateTime: '2026-07-23T15:30:00Z' },
          extendedProperties: { private: { marisol_booking_id: 'bk_1' } },
        },
        { id: 'evt_2', status: 'cancelled' },
      ],
    });
    const page = await gcalListDeltas('primary', 'tok', { syncToken: 'st_1' });
    expect(page.events).toEqual([
      {
        id: 'evt_1',
        status: 'confirmed',
        start: { dateTime: '2026-07-23T15:00:00Z' },
        end: { dateTime: '2026-07-23T15:30:00Z' },
        bookingId: 'bk_1',
      },
      { id: 'evt_2', status: 'cancelled' },
    ]);
  });

  it('surfaces an expired sync token as a typed 410', async () => {
    captureUrl(410, {});
    const err = await gcalListDeltas('primary', 'tok', { syncToken: 'st_old' }).catch((e) => e);
    expect(err).toBeInstanceOf(GCalHttpError);
    expect((err as GCalHttpError).status).toBe(410);
  });
});
