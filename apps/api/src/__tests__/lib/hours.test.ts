import { describe, expect, it } from 'bun:test';
import {
  getHoursForDate,
  isClosed,
  localIso,
  offsetLabel,
  spokenTimeLabel,
  validateBookingTime,
} from '../../lib/hours';
import type { ShopRow } from '../../types';

describe('hours — offsetLabel', () => {
  it('formats a negative offset', () => {
    expect(offsetLabel(-240)).toBe('-04:00');
  });
  it('formats a fractional positive offset', () => {
    expect(offsetLabel(330)).toBe('+05:30');
  });
  it('formats zero', () => {
    expect(offsetLabel(0)).toBe('+00:00');
  });
});

describe('hours — localIso', () => {
  it('renders a UTC instant in the shop offset (digits = local clock)', () => {
    const ms = Date.parse('2026-05-30T14:00:00Z'); // 10:00 in EDT
    expect(localIso(ms, -240)).toBe('2026-05-30T10:00:00-04:00');
  });
});

describe('hours — spokenTimeLabel', () => {
  it('speaks the local clock time', () => {
    const ms = Date.parse('2026-05-30T14:00:00Z');
    expect(spokenTimeLabel(ms, 'America/New_York')).toBe('10:00 AM');
  });
});

describe('hours — getHoursForDate', () => {
  const hours = '{"Mon-Fri":"9am-7pm","Sat":"10am-5pm"}';
  it('matches a weekday range (Fri 2026-05-29)', () => {
    expect(getHoursForDate(hours, '2026-05-29')).toEqual({ open: 540, close: 1140 });
  });
  it('matches Saturday', () => {
    expect(getHoursForDate(hours, '2026-05-30')).toEqual({ open: 600, close: 1020 });
  });
  it('returns null for an unlisted day (Sun 2026-05-31)', () => {
    expect(getHoursForDate(hours, '2026-05-31')).toBeNull();
  });
});

describe('hours — isClosed', () => {
  it('detects a closure date', () => {
    expect(isClosed('["2026-12-25"]', '2026-12-25')).toBe(true);
  });
  it('is false otherwise', () => {
    expect(isClosed('["2026-12-25"]', '2026-05-30')).toBe(false);
  });
});

const shop = {
  timezone: 'America/New_York',
  hours_json: '{"Sun-Sat":"9am-7pm"}',
  closures_json: '["2099-06-15"]',
} as unknown as ShopRow;

describe('hours — validateBookingTime', () => {
  it('accepts a future in-hours slot', () => {
    expect(validateBookingTime(shop, '2099-06-16T14:00:00-04:00', 30)).toEqual({ ok: true });
  });
  it('rejects a past time', () => {
    expect(validateBookingTime(shop, '2000-01-01T14:00:00-05:00', 30).ok).toBe(false);
  });
  it('rejects a time before opening', () => {
    expect(validateBookingTime(shop, '2099-06-16T08:00:00-04:00', 30)).toEqual({
      ok: false,
      reason: 'outside_hours',
    });
  });
  it('rejects a closure date', () => {
    expect(validateBookingTime(shop, '2099-06-15T14:00:00-04:00', 30)).toEqual({
      ok: false,
      reason: 'closed',
    });
  });

  // 2099-06-16 is a Tuesday, 2099-06-17 a Wednesday.
  const luis = { id: 'stf_luis', name: 'Luis', hours: { Tue: '10am-2pm' } };

  it('rejects a shop-hours time on a day the staff member is off', () => {
    expect(validateBookingTime(shop, '2099-06-17T14:00:00-04:00', 30, luis)).toEqual({
      ok: false,
      reason: 'staff_away',
    });
  });

  it('rejects a time outside the staff hours but inside the shop hours', () => {
    expect(validateBookingTime(shop, '2099-06-16T09:00:00-04:00', 30, luis)).toEqual({
      ok: false,
      reason: 'staff_away',
    });
  });

  it('rejects an appointment running past the end of the staff hours', () => {
    expect(validateBookingTime(shop, '2099-06-16T13:45:00-04:00', 30, luis)).toEqual({
      ok: false,
      reason: 'staff_away',
    });
  });

  it('accepts a time inside the staff hours', () => {
    expect(validateBookingTime(shop, '2099-06-16T11:00:00-04:00', 30, luis)).toEqual({ ok: true });
  });

  it('is unchanged for a member without their own hours', () => {
    const ana = { id: 'stf_ana', name: 'Ana' };
    expect(validateBookingTime(shop, '2099-06-17T14:00:00-04:00', 30, ana)).toEqual({ ok: true });
  });
});
