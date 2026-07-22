import { describe, expect, it } from 'bun:test';
import { buildSlots } from '../../routes/tools/check-availability';
import type { ShopRow } from '../../types';

// Ana works the shop's full hours; Luis only Tuesdays 10am–2pm.
const shop = {
  timezone: 'America/New_York',
  hours_json: '{"Sun-Sat":"9am-5pm"}',
  closures_json: '[]',
  staff_json: JSON.stringify([
    { id: 'stf_ana', name: 'Ana' },
    { id: 'stf_luis', name: 'Luis', hours: { Tue: '10am-2pm' } },
  ]),
} as unknown as ShopRow;

const MONDAY = '2099-06-15';
const TUESDAY = '2099-06-16';
const SHOP_HOURS = { open: 540, close: 1020 };

function slots(date: string, requestedStaff?: string) {
  return buildSlots({
    shop,
    date,
    durationMinutes: 60,
    shopHours: SHOP_HOURS,
    requestedStaff,
    bookings: [],
    foreignBusy: [],
  });
}

describe('check_availability — per-staff hours', () => {
  it("offers a full-schedule member on a day the other one is off (staff='any')", () => {
    const names = new Set(slots(MONDAY, 'any').map((s) => s.staff_name));
    expect(names).toEqual(new Set(['Ana']));
  });

  it('returns nothing for a member who does not work that day', () => {
    expect(slots(MONDAY, 'Luis')).toEqual([]);
  });

  it('trims a narrower schedule from both ends', () => {
    const labels = slots(TUESDAY, 'Luis').map((s) => s.label);
    expect(labels).toEqual(['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM']);
  });

  it('leaves a member without their own hours on the full shop grid', () => {
    const labels = slots(TUESDAY, 'Ana').map((s) => s.label);
    expect(labels).toEqual([
      '9:00 AM',
      '10:00 AM',
      '11:00 AM',
      '12:00 PM',
      '1:00 PM',
      '2:00 PM',
      '3:00 PM',
      '4:00 PM',
    ]);
  });

  it('falls back to the first available member per slot when nobody is requested', () => {
    // Ana is free all day, so 'any' picks her for every slot and never offers Luis
    // a time he isn't working.
    const bySlot = slots(TUESDAY);
    expect(bySlot).toHaveLength(8);
    expect(new Set(bySlot.map((s) => s.staff_name))).toEqual(new Set(['Ana']));
  });

  it('skips a member already booked and offers the other one', () => {
    const booked = buildSlots({
      shop,
      date: TUESDAY,
      durationMinutes: 60,
      shopHours: SHOP_HOURS,
      requestedStaff: 'any',
      bookings: [
        { start_at: '2099-06-16T14:00:00Z', end_at: '2099-06-16T15:00:00Z', staff: 'Ana' },
      ],
      foreignBusy: [],
    });
    // 14:00Z is 10:00 EDT — Luis is working then, so the slot survives under his name.
    expect(booked.find((s) => s.label === '10:00 AM')?.staff_name).toBe('Luis');
  });

  it('accepts a name that is not on the staff list, on shop hours', () => {
    expect(slots(MONDAY, 'Guest')).toHaveLength(8);
  });

  it('resolves a name the agent echoed back with its schedule bracket', () => {
    expect(slots(MONDAY, 'Luis (works Tue)')).toEqual([]);
    expect(slots(TUESDAY, 'Luis (works Tue)').map((s) => s.staff_name)).toEqual([
      'Luis',
      'Luis',
      'Luis',
      'Luis',
    ]);
  });
});

describe('check_availability — per-staff busy calendars', () => {
  // 14:00Z = 10:00 EDT on this date.
  const tenToEleven = {
    start: Date.parse('2099-06-16T14:00:00Z'),
    end: Date.parse('2099-06-16T15:00:00Z'),
  };

  it("a manual entry in one member's calendar leaves the other one bookable", () => {
    const out = buildSlots({
      shop,
      date: TUESDAY,
      durationMinutes: 60,
      shopHours: SHOP_HOURS,
      requestedStaff: 'any',
      bookings: [],
      foreignBusy: [],
      perStaffBusy: { stf_ana: [tenToEleven] },
    });
    expect(out.find((s) => s.label === '10:00 AM')?.staff_name).toBe('Luis');
  });

  it('removes the slot entirely for the member whose calendar is blocked', () => {
    const out = buildSlots({
      shop,
      date: TUESDAY,
      durationMinutes: 60,
      shopHours: SHOP_HOURS,
      requestedStaff: 'Ana',
      bookings: [],
      foreignBusy: [],
      perStaffBusy: { stf_ana: [tenToEleven] },
    });
    expect(out.map((s) => s.label)).not.toContain('10:00 AM');
  });

  it('an entry in a shared calendar removes the slot for everyone', () => {
    const out = buildSlots({
      shop,
      date: TUESDAY,
      durationMinutes: 60,
      shopHours: SHOP_HOURS,
      requestedStaff: 'any',
      bookings: [],
      foreignBusy: [tenToEleven],
      perStaffBusy: {},
    });
    expect(out.map((s) => s.label)).not.toContain('10:00 AM');
  });
});
