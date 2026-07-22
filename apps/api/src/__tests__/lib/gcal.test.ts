import { afterEach, describe, expect, it } from 'bun:test';
import {
  canWriteTo,
  gcalCreateEvent,
  gcalListBusy,
  gcalListCalendars,
  getGCalBusy,
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

describe('getGCalBusy', () => {
  const env = { ENCRYPTION_KEY: 'a'.repeat(64) } as WorkerBindings;

  it('returns [] when the shop has no google_calendar integration', async () => {
    const shop = {
      integration: 'none',
      integration_credentials_encrypted: null,
    } as unknown as ShopRow;
    expect(await getGCalBusy(env, shop, 'a', 'b')).toEqual([]);
  });

  it('fails open to [] when credentials cannot be decrypted', async () => {
    const shop = {
      integration: 'google_calendar',
      integration_credentials_encrypted: 'not-valid-creds',
    } as unknown as ShopRow;
    expect(await getGCalBusy(env, shop, 'a', 'b')).toEqual([]);
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
});
