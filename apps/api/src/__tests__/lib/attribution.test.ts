import { describe, expect, it } from 'bun:test';
import { attributeEvent, splitByAttribution, summarizeEventColors } from '../../lib/attribution';
import type { GCalBusy } from '../../lib/gcal';
import { parseStaff } from '../../lib/staff';

const staff = parseStaff('[{"id":"stf_ana","name":"Ana"},{"id":"stf_luis","name":"Luís"}]');

function event(extra: Partial<GCalBusy> = {}): GCalBusy {
  return { id: 'e1', start: 0, end: 1, ...extra };
}

describe('attributeEvent — off', () => {
  it('never attributes, so a foreign event blocks the whole shop', () => {
    expect(
      attributeEvent(event({ colorId: '5', summary: 'Ana — cut' }), { mode: 'off' }, staff),
    ).toBeNull();
  });
});

describe('attributeEvent — color', () => {
  const attribution = { mode: 'color' as const, colors: { '5': 'stf_ana' } };

  it('attributes an event carrying the mapped colour', () => {
    expect(attributeEvent(event({ colorId: '5' }), attribution, staff)?.id).toBe('stf_ana');
  });

  it('blocks everyone when the event has no colour of its own', () => {
    expect(attributeEvent(event(), attribution, staff)).toBeNull();
  });

  it('blocks everyone for a colour nobody claimed', () => {
    expect(attributeEvent(event({ colorId: '9' }), attribution, staff)).toBeNull();
  });

  it('blocks everyone when the mapped staff member no longer exists', () => {
    const stale = { mode: 'color' as const, colors: { '5': 'stf_gone' } };
    expect(attributeEvent(event({ colorId: '5' }), stale, staff)).toBeNull();
  });
});

describe('attributeEvent — title_prefix', () => {
  const attribution = { mode: 'title_prefix' as const };

  it('attributes a title that starts with the name', () => {
    expect(attributeEvent(event({ summary: 'Ana — haircut' }), attribution, staff)?.id).toBe(
      'stf_ana',
    );
    expect(attributeEvent(event({ summary: 'ana: colour' }), attribution, staff)?.id).toBe(
      'stf_ana',
    );
    expect(attributeEvent(event({ summary: 'Ana' }), attribution, staff)?.id).toBe('stf_ana');
  });

  it('ignores diacritics on both sides', () => {
    expect(attributeEvent(event({ summary: 'Luis | cut' }), attribution, staff)?.id).toBe(
      'stf_luis',
    );
  });

  it('blocks everyone when the name is not the prefix', () => {
    // Ana is the customer here — attributing this would free Ana's chair wrongly.
    expect(
      attributeEvent(event({ summary: 'haircut — Ana Kowalska' }), attribution, staff),
    ).toBeNull();
  });

  it('blocks everyone when the name only starts a longer word', () => {
    expect(attributeEvent(event({ summary: 'Anastasia cut' }), attribution, staff)).toBeNull();
  });

  it('blocks everyone for an untitled event', () => {
    expect(attributeEvent(event(), attribution, staff)).toBeNull();
  });
});

describe('summarizeEventColors', () => {
  it('reports only used colours, each with its event count', () => {
    const usage = summarizeEventColors(
      [
        event({ id: 'a', colorId: '5' }),
        event({ id: 'b', colorId: '5' }),
        event({ id: 'c', colorId: '7' }),
      ],
      staff,
    );
    expect(usage.map((u) => [u.colorId, u.count])).toEqual([
      ['5', 2],
      ['7', 1],
    ]);
  });

  it('ignores events with no colour of their own', () => {
    const usage = summarizeEventColors(
      [event({ id: 'a' }), event({ id: 'b', colorId: '3' })],
      staff,
    );
    expect(usage.map((u) => u.colorId)).toEqual(['3']);
  });

  it('hints the staff member whose name prefixes every titled entry in a colour', () => {
    const usage = summarizeEventColors(
      [
        event({ id: 'a', colorId: '5', summary: 'Ana — cut' }),
        event({ id: 'b', colorId: '5', summary: 'supplier delivery' }),
      ],
      staff,
    );
    expect(usage[0]?.hintStaffId).toBe('stf_ana');
    expect(usage[0]?.hintTitle).toBe('Ana — cut');
  });

  it('gives no hint when one colour names two different people', () => {
    const usage = summarizeEventColors(
      [
        event({ id: 'a', colorId: '5', summary: 'Ana — cut' }),
        event({ id: 'b', colorId: '5', summary: 'Luís | trim' }),
      ],
      staff,
    );
    expect(usage[0]?.hintStaffId).toBeUndefined();
  });

  it('gives no hint when no title matches a staff name', () => {
    const usage = summarizeEventColors(
      [event({ id: 'a', colorId: '5', summary: 'dentist' })],
      staff,
    );
    expect(usage[0]?.hintStaffId).toBeUndefined();
  });
});

describe('splitByAttribution', () => {
  it('leaves everything shared when attribution is off', () => {
    const shared = [event({ id: 'a', summary: 'Ana — cut' })];
    const out = splitByAttribution(shared, {}, { mode: 'off' }, staff);
    expect(out.shared.map((e) => e.id)).toEqual(['a']);
    expect(out.perStaff).toEqual({});
  });

  it('moves attributed events into the staff bucket and keeps the rest shared', () => {
    const shared = [
      event({ id: 'a', summary: 'Ana — cut' }),
      event({ id: 'b', summary: 'supplier delivery' }),
    ];
    const out = splitByAttribution(
      shared,
      { stf_ana: [event({ id: 'z' })] },
      {
        mode: 'title_prefix',
      },
      staff,
    );
    expect(out.shared.map((e) => e.id)).toEqual(['b']);
    expect(out.perStaff.stf_ana?.map((e) => e.id)).toEqual(['z', 'a']);
  });
});
