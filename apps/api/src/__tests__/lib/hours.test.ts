import { describe, expect, it } from 'bun:test';
import {
  ambiguousHoursDay,
  getHoursForDate,
  isClosed,
  isValidHoursKey,
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

  // Which key answers for a day used to depend on the order they were written in, which no owner
  // and no form controls. A day named outright wins, and once a key has answered it is the answer.
  it('lets a day named outright override a range that covers it', () => {
    const wed = '{"Mon-Fri":"9am-7pm","Wed":"9am-2pm"}';
    expect(getHoursForDate(wed, '2026-05-27')).toEqual({ open: 540, close: 840 });
    const reversed = '{"Wed":"9am-2pm","Mon-Fri":"9am-7pm"}';
    expect(getHoursForDate(reversed, '2026-05-27')).toEqual({ open: 540, close: 840 });
  });

  it('keeps a day shut that says closed, whatever a later range claims', () => {
    expect(getHoursForDate('{"Sun":"closed","Sat-Sun":"9am-4pm"}', '2026-05-31')).toBeNull();
  });

  it('reads nothing from a key that names no day', () => {
    expect(getHoursForDate('{"Modnay":"9am-7pm"}', '2026-05-25')).toBeNull();
  });
});

describe('hours — overlapping ranges', () => {
  // 2026-05-27 is a Wednesday, covered by both keys.
  const open = '{"Mon-Fri":"9am-5pm","Wed-Sun":"closed"}';
  const reversed = '{"Wed-Sun":"closed","Mon-Fri":"9am-5pm"}';

  it('refuses a day two ranges disagree about, in either key order', () => {
    expect(getHoursForDate(open, '2026-05-27')).toBeNull();
    expect(getHoursForDate(reversed, '2026-05-27')).toBeNull();
  });

  it('still answers for the days only one of them covers', () => {
    expect(getHoursForDate(open, '2026-05-26')).toEqual({ open: 540, close: 1020 });
    expect(getHoursForDate(open, '2026-05-30')).toBeNull();
  });

  it('takes ranges that say the same thing as agreement', () => {
    const twice = '{"Mon-Wed":"9am-5pm","Wed-Fri":"9am-5pm"}';
    expect(getHoursForDate(twice, '2026-05-27')).toEqual({ open: 540, close: 1020 });
  });

  it('lets a key naming the day settle what the ranges cannot', () => {
    const settled = '{"Mon-Fri":"9am-5pm","Wed-Sun":"closed","Wed":"10am-2pm"}';
    expect(getHoursForDate(settled, '2026-05-27')).toEqual({ open: 600, close: 840 });
  });
});

describe('hours — ambiguousHoursDay', () => {
  it('names the first day two ranges disagree about', () => {
    expect(ambiguousHoursDay({ 'Mon-Fri': '9am-5pm', 'Wed-Sun': 'closed' })).toBe('Wed');
  });

  it('passes a week whose ranges do not overlap', () => {
    expect(ambiguousHoursDay({ 'Mon-Fri': '9am-5pm', Sat: '9am-4pm' })).toBeNull();
  });

  it('skips a day a single-day key settles and names the next one', () => {
    expect(ambiguousHoursDay({ 'Mon-Fri': '9am-5pm', 'Wed-Sun': 'closed', Wed: '10am-2pm' })).toBe(
      'Thu',
    );
  });

  it('passes once every overlapping day is named outright', () => {
    expect(
      ambiguousHoursDay({
        'Mon-Fri': '9am-5pm',
        'Wed-Sun': 'closed',
        Wed: '10am-2pm',
        Thu: '10am-2pm',
        Fri: 'closed',
      }),
    ).toBeNull();
  });

  it('passes ranges that agree', () => {
    expect(ambiguousHoursDay({ 'Mon-Wed': '9am-5pm', 'Wed-Fri': '9am-5pm' })).toBeNull();
  });
});

describe('hours — isValidHoursKey', () => {
  // The admin edge refuses on this, because a key the parser cannot match closes the shop that day
  // in silence — every value check still passes.
  it('accepts a day and an inclusive range, including one that wraps', () => {
    for (const key of ['Mon', 'sun', 'Mon-Fri', 'Sat-Sun', 'Fri-Mon']) {
      expect(isValidHoursKey(key)).toBe(true);
    }
  });

  it('refuses a misspelt day, a half-written range and a third bound', () => {
    for (const key of ['Modnay', 'Monday-Friday', 'Mon-', '', 'Mon-Wed-Fri']) {
      expect(isValidHoursKey(key)).toBe(false);
    }
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
