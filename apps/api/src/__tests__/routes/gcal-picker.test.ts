import { describe, expect, it } from 'bun:test';
import { parseStaff } from '../../lib/staff';
import {
  canConnectCalendar,
  colorMapMarkup,
  portalReturnLink,
  selectForm,
} from '../../routes/integrations/google';
import type { CalendarRouting, ShopRow, WorkerBindings } from '../../types';

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

describe('assisted calendar access', () => {
  it('requires a grant and permits prepared suspended shops without opening cancelled shops', () => {
    expect(canConnectCalendar({ status: 'active', integration: 'none' } as ShopRow)).toBe(false);
    expect(
      canConnectCalendar({ status: 'active', calendar_access_granted_at: '2026-09-06' } as ShopRow),
    ).toBe(true);
    expect(
      canConnectCalendar({ status: 'active', integration: 'google_calendar' } as ShopRow),
    ).toBe(true);
    expect(
      canConnectCalendar({
        status: 'suspended',
        calendar_access_granted_at: '2026-09-06',
        integration: 'none',
      } as ShopRow),
    ).toBe(true);
    for (const status of ['cancelled', 'pending_review']) {
      expect(
        canConnectCalendar({
          status,
          calendar_access_granted_at: '2026-09-06',
          integration: 'google_calendar',
        } as ShopRow),
      ).toBe(false);
    }
  });
  it('only renders a configured HTTPS return link', () => {
    expect(
      portalReturnLink({
        PORTAL_URL: 'https://app.callmarisol.com/portal/calendar',
      } as WorkerBindings),
    ).toContain('Return to your dashboard');
    expect(portalReturnLink({ PORTAL_URL: 'javascript:alert(1)' } as WorkerBindings)).toBe('');
    expect(portalReturnLink({} as WorkerBindings)).toBe('');
  });
  it('keeps advanced mappings in the form while hiding them until requested', () => {
    const input = {
      shopId: 'shop',
      sig: 'sig',
      calendars: [],
      staff,
      routing: { ...routing({}), attribution: { mode: 'off' as const } },
    };
    const html = selectForm(input);
    expect(html).toContain('<summary>Advanced: appointments in a shared calendar</summary>');
    expect(html).toContain('id="color_mapping" hidden');
    expect(fields(html)).toHaveLength(11);
    expect(selectForm({ ...input, routing: routing({ '5': 'stf_ana' }) })).toContain(
      'id="color_mapping"><p',
    );
  });
});
