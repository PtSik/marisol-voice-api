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
export function matchesTitlePrefix(title: string, name: string): boolean {
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

export interface ColorUsage {
  colorId: string;
  count: number;
  // A single staff member whose name prefixes the titles in this colour, if one clearly
  // dominates. The picker pre-selects this mapping but never saves it on its own.
  hintStaffId?: string;
  hintTitle?: string;
}

// Which Google event colours a calendar actually uses and, per colour, whether its titles
// point at one staff member — the raw material for the picker's colour hints. A colour whose
// titles name two different people yields no hint (a wrong colour→staff mapping frees a slot).
export function summarizeEventColors(events: GCalBusy[], staff: StaffMember[]): ColorUsage[] {
  const byColor = new Map<string, GCalBusy[]>();
  for (const event of events) {
    if (!event.colorId) continue;
    const bucket = byColor.get(event.colorId);
    if (bucket) bucket.push(event);
    else byColor.set(event.colorId, [event]);
  }

  const usage: ColorUsage[] = [];
  for (const [colorId, colorEvents] of byColor) {
    const matched = new Map<string, string>();
    for (const event of colorEvents) {
      if (!event.summary) continue;
      const member = staff.find((m) => matchesTitlePrefix(event.summary as string, m.name));
      if (member && !matched.has(member.id)) matched.set(member.id, event.summary);
    }
    const entry: ColorUsage = { colorId, count: colorEvents.length };
    if (matched.size === 1) {
      const [staffId, title] = [...matched][0] as [string, string];
      entry.hintStaffId = staffId;
      entry.hintTitle = title;
    }
    usage.push(entry);
  }

  usage.sort((a, b) => b.count - a.count || Number(a.colorId) - Number(b.colorId));
  return usage;
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
