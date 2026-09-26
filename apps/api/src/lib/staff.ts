import { DAY_NAMES, hoursForDayIndex } from './hours';

export interface StaffMember {
  id: string;
  name: string;
  // Same shape as shops.hours_json; absent means "inherit the shop's hours".
  hours?: Record<string, string>;
}

function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'staff';
  let id = `stf_${base}`;
  let n = 2;
  while (taken.has(id)) id = `stf_${base}-${n++}`;
  return id;
}

function parseHours(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[day] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// The single normaliser for shops.staff_json. Every row carries `[{id, name, hours?}]` since
// migration 0027; an entry that arrives without an id still gets one derived from the name
// (deterministic — this runs per request and must agree across tool calls).
export function parseStaff(staffJson: string): StaffMember[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(staffJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const taken = new Set<string>();
  const members: StaffMember[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : undefined;
    const hours = parseHours(e.hours);
    if (!name) continue;
    const finalId = id && !taken.has(id) ? id : slugId(name, taken);
    taken.add(finalId);
    members.push(hours ? { id: finalId, name, hours } : { id: finalId, name });
  }
  return members;
}

// staffSummary hands the agent "Luis (works Tue, Thu)"; the prompt says to drop the bracket
// but an agent that echoes it back must still resolve to Luis.
export function normalizeStaffName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function findInRoster(
  roster: StaffMember[],
  name: string | undefined,
): StaffMember | undefined {
  if (!name) return undefined;
  const wanted = normalizeStaffName(name).toLowerCase();
  if (!wanted) return undefined;
  return roster.find((m) => m.name.toLowerCase() === wanted);
}

export function findStaff(staffJson: string, name: string | undefined): StaffMember | undefined {
  return findInRoster(parseStaff(staffJson), name);
}

// A transcription slip ("Luiz" for "Luis") must not become a booking for someone who does
// not exist: their schedule is never checked and the GiST EXCLUDE, keyed on the staff text,
// lets a second booking through for the same chair. A shop with an empty roster still books.
export function resolveStaffForBooking(
  staffJson: string,
  name: string | undefined,
): { member: StaffMember | undefined; roster: StaffMember[] } | { unknown: string[] } {
  const roster = parseStaff(staffJson);
  const member = findInRoster(roster, name);
  if (roster.length > 0 && !member) return { unknown: roster.map((m) => m.name) };
  // The roster comes back so the booking path does not parse staff_json a second time.
  return { member, roster };
}

// Names only — the agent must never see staff ids. Members with their own schedule carry
// a short note so the agent doesn't offer someone who isn't in that day.
export function staffSummary(staff: StaffMember[]): string {
  return staff
    .map((m) => {
      const hours = m.hours;
      if (!hours) return m.name;
      // Resolved exactly as the booking guard resolves it — a summary that offers a day the
      // guard then refuses sends the caller through a booking that cannot complete.
      const days = DAY_NAMES.filter((_, i) => hoursForDayIndex(hours, i) !== null);
      return days.length > 0 ? `${m.name} (works ${days.join(', ')})` : m.name;
    })
    .join(', ');
}
