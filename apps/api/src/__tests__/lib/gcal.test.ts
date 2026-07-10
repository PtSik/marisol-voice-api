import { afterEach, describe, expect, it } from 'bun:test';
import { gcalListBusy, getGCalBusy } from '../../lib/gcal';
import type { ShopRow, WorkerBindings } from '../../types';

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
