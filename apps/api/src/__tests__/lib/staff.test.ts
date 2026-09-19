import { describe, expect, it } from 'bun:test';
import { getStaffHoursForDate } from '../../lib/hours';
import { findStaff, parseStaff, resolveStaffForBooking, staffSummary } from '../../lib/staff';
import type { ShopRow } from '../../types';

const shop = {
  timezone: 'America/New_York',
  hours_json: '{"Sun-Sat":"9am-7pm"}',
  closures_json: '[]',
} as unknown as ShopRow;

const MONDAY = '2099-06-15';
const TUESDAY = '2099-06-16';

describe('staff — parseStaff', () => {
  it('reads the legacy string[] shape', () => {
    expect(parseStaff('["Ana","Luis"]')).toEqual([
      { id: 'stf_ana', name: 'Ana' },
      { id: 'stf_luis', name: 'Luis' },
    ]);
  });

  it('keeps a stored id when the name changes', () => {
    const before = parseStaff('[{"id":"stf_a1b2c3","name":"Ana"}]');
    const after = parseStaff('[{"id":"stf_a1b2c3","name":"Ana R."}]');
    expect(after[0]?.id).toBe(before[0]?.id as string);
    expect(after[0]?.name).toBe('Ana R.');
  });

  it('keeps per-member hours and drops nameless entries', () => {
    expect(parseStaff('[{"name":"Luis","hours":{"Tue":"9am-5pm"}},{"name":"  "}]')).toEqual([
      { id: 'stf_luis', name: 'Luis', hours: { Tue: '9am-5pm' } },
    ]);
  });

  it('disambiguates two members with the same name', () => {
    expect(parseStaff('["Ana","Ana"]').map((m) => m.id)).toEqual(['stf_ana', 'stf_ana-2']);
  });

  it('returns an empty list for malformed json', () => {
    expect(parseStaff('not json')).toEqual([]);
    expect(parseStaff('{"a":1}')).toEqual([]);
  });
});

describe('staff — findStaff', () => {
  it('matches case-insensitively', () => {
    expect(findStaff('["Ana"]', 'ana')?.name).toBe('Ana');
  });
  it('ignores a schedule bracket the agent echoed back', () => {
    expect(findStaff('[{"name":"Luis","hours":{"Tue":"9am-5pm"}}]', 'Luis (works Tue)')?.name).toBe(
      'Luis',
    );
  });
  it('returns undefined for an unknown or missing name', () => {
    expect(findStaff('["Ana"]', 'Luis')).toBeUndefined();
    expect(findStaff('["Ana"]', undefined)).toBeUndefined();
  });
});

describe('staff — getStaffHoursForDate', () => {
  it('inherits the shop hours when the member has none', () => {
    const [ana] = parseStaff('["Ana"]');
    expect(getStaffHoursForDate(shop, ana, MONDAY)).toEqual({ open: 540, close: 1140 });
  });

  it('returns null on a day the member does not work', () => {
    const [luis] = parseStaff('[{"name":"Luis","hours":{"Tue":"9am-5pm"}}]');
    expect(getStaffHoursForDate(shop, luis, MONDAY)).toBeNull();
  });

  it('narrows the shop hours from both ends', () => {
    const [luis] = parseStaff('[{"name":"Luis","hours":{"Tue":"10am-5pm"}}]');
    expect(getStaffHoursForDate(shop, luis, TUESDAY)).toEqual({ open: 600, close: 1020 });
  });

  it('never widens past the shop hours', () => {
    const [luis] = parseStaff('[{"name":"Luis","hours":{"Tue":"6am-11pm"}}]');
    expect(getStaffHoursForDate(shop, luis, TUESDAY)).toEqual({ open: 540, close: 1140 });
  });

  it('accepts lowercase day keys', () => {
    const [luis] = parseStaff('[{"name":"Luis","hours":{"tue":"10am-5pm"}}]');
    expect(getStaffHoursForDate(shop, luis, TUESDAY)).toEqual({ open: 600, close: 1020 });
  });

  it('returns null when the shop itself is closed', () => {
    const closedShop = { ...shop, hours_json: '{"Mon":"closed"}' } as ShopRow;
    const [ana] = parseStaff('["Ana"]');
    expect(getStaffHoursForDate(closedShop, ana, MONDAY)).toBeNull();
  });
});

describe('staff — staffSummary', () => {
  it('sends names only when nobody has a custom schedule', () => {
    expect(staffSummary(parseStaff('["Ana","Luis"]'))).toBe('Ana, Luis');
  });

  it('annotates working days for members with their own hours', () => {
    const staff = parseStaff('["Ana",{"name":"Luis","hours":{"Tue":"9am-5pm","Thu":"9am-5pm"}}]');
    expect(staffSummary(staff)).toBe('Ana, Luis (works Tue, Thu)');
  });

  it('never leaks ids', () => {
    expect(staffSummary(parseStaff('["Ana"]'))).not.toContain('stf_');
  });
});

describe('staff — resolveStaffForBooking', () => {
  const roster = '[{"id":"stf_ana","name":"Ana"},{"id":"stf_luis","name":"Luis"}]';

  it('resolves a known name to its member', () => {
    const r = resolveStaffForBooking(roster, 'luis');
    expect('unknown' in r).toBe(false);
    expect(('member' in r && r.member?.id) || null).toBe('stf_luis');
  });

  it('rejects a name that is not on the roster and reports who is', () => {
    const r = resolveStaffForBooking(roster, 'Luiz');
    expect(r).toEqual({ unknown: ['Ana', 'Luis'] });
  });

  it('lets a shop with no roster book anyone', () => {
    expect(resolveStaffForBooking('[]', 'Whoever')).toEqual({ member: undefined, roster: [] });
  });

  it('accepts the name the agent may echo back with its schedule note', () => {
    const withHours = '[{"id":"stf_luis","name":"Luis","hours":{"Tue":"9am-5pm"}}]';
    const r = resolveStaffForBooking(withHours, 'Luis (works Tue)');
    expect(('member' in r && r.member?.id) || null).toBe('stf_luis');
  });
});
