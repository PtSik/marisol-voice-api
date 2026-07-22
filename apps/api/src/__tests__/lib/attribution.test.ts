import { describe, expect, it } from 'bun:test';
import { attributeEvent, splitByAttribution } from '../../lib/attribution';
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
