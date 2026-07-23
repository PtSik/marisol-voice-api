import { describe, expect, it } from 'bun:test';
import { parseStaff } from '../../lib/staff';
import { colorMapMarkup } from '../../routes/integrations/google';
import type { CalendarRouting } from '../../types';

const staff = parseStaff(
  JSON.stringify([
    { id: 'stf_ana', name: 'Ana' },
    { id: 'stf_luis', name: 'Luís' },
  ]),
);

function routing(colors: Record<string, string>): CalendarRouting {
  return {
    write_calendar_id: 'c_main',
    staff_calendars: {},
    busy_calendar_ids: [],
    attribution: { mode: 'color', colors },
  };
}

const fields = (html: string) => [...html.matchAll(/name="colorstaff_(\d+)"/g)].map((m) => m[1]);

function selectedFor(html: string, colorId: string): string {
  const row = html.split(`name="colorstaff_${colorId}"`)[1]?.split('</select>')[0] ?? '';
  return row.match(/value="([^"]*)" selected/)?.[1] ?? '';
}

describe('colorMapMarkup', () => {
  it('keeps a field for every colour so a save cannot drop an unobserved mapping', () => {
    const html = colorMapMarkup(staff, routing({ '7': 'stf_luis' }), [{ colorId: '5', count: 3 }]);
    expect(fields(html).sort()).toEqual(
      ['1', '10', '11', '2', '3', '4', '5', '6', '7', '8', '9'].sort(),
    );
    expect(selectedFor(html, '7')).toBe('stf_luis');
  });

  it('leads with the observed colours and hides the rest behind the disclosure', () => {
    const html = colorMapMarkup(staff, routing({}), [{ colorId: '5', count: 3 }]);
    const [before, after] = html.split('<details');
    expect(fields(before ?? '')).toEqual(['5']);
    expect(fields(after ?? '')).not.toContain('5');
    expect(before).toContain('3 entries');
  });

  it('renders the whole palette flat when nothing was observed', () => {
    const html = colorMapMarkup(staff, routing({}), undefined);
    expect(html).not.toContain('<details');
    expect(fields(html)).toHaveLength(11);
  });

  it('prefers a saved mapping over the scan hint', () => {
    const html = colorMapMarkup(staff, routing({ '5': 'stf_ana' }), [
      { colorId: '5', count: 2, hintStaffId: 'stf_luis', hintTitle: 'Luís — trim' },
    ]);
    expect(selectedFor(html, '5')).toBe('stf_ana');
    expect(html).not.toContain('suggested from');
  });
});
