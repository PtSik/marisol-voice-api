import type { CalendarAttribution } from '../types';
import type { GCalBusy } from './gcal';
import type { StaffMember } from './staff';

const SEPARATORS = ['—', '–', '-', ':', '|', ','];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

// Anchored on the start of the title on purpose: matching the name anywhere turns
// "haircut — Ana Kowalska" (Ana is the customer) into a booking for Ana, and a wrong
// attribution *frees* a slot, so it errs towards double-booking.
function matchesTitlePrefix(title: string, name: string): boolean {
  const t = normalize(title);
  const n = normalize(name);
  if (!n || !t.startsWith(n)) return false;
  const rest = t.slice(n.length).trimStart();
  return rest === '' || SEPARATORS.some((sep) => rest.startsWith(sep));
}

// Which staff member a foreign calendar event belongs to, or null when we can't tell — and
// "can't tell" means the event blocks everyone, which is the safe direction. Only ever
// applied to foreign events; our own are filtered out by gcal_event_id beforehand.
export function attributeEvent(
  event: GCalBusy,
  attribution: CalendarAttribution,
  staff: StaffMember[],
): StaffMember | null {
  if (attribution.mode === 'color') {
    if (!event.colorId) return null;
    const staffId = attribution.colors?.[event.colorId];
    return staff.find((m) => m.id === staffId) ?? null;
  }
  if (attribution.mode === 'title_prefix') {
    const summary = event.summary;
    if (!summary) return null;
    return staff.find((m) => matchesTitlePrefix(summary, m.name)) ?? null;
  }
  return null;
}

// Foreign events that name a staff member move out of "blocks the whole shop" into that
// person's own bucket; everything else stays shared.
export function splitByAttribution(
  shared: GCalBusy[],
  perStaff: Record<string, GCalBusy[]>,
  attribution: CalendarAttribution,
  staff: StaffMember[],
): { shared: GCalBusy[]; perStaff: Record<string, GCalBusy[]> } {
  if (attribution.mode === 'off') return { shared, perStaff };

  const nextShared: GCalBusy[] = [];
  const nextPerStaff: Record<string, GCalBusy[]> = { ...perStaff };
  for (const event of shared) {
    const member = attributeEvent(event, attribution, staff);
    if (!member) {
      nextShared.push(event);
      continue;
    }
    nextPerStaff[member.id] = [...(nextPerStaff[member.id] ?? []), event];
  }
  return { shared: nextShared, perStaff: nextPerStaff };
}
