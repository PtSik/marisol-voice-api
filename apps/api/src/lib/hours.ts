import type { ShopRow } from '../types';
import type { StaffMember } from './staff';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayIndexFromName(token: string): number {
  const t = token.trim().toLowerCase();
  return DAY_NAMES.findIndex((d) => d.toLowerCase() === t);
}

// An hours key is either a single day ("Sun") or an inclusive range ("Mon-Fri"),
// which may wrap around the week ("Sat-Sun"). Matching is case-insensitive so both
// {"Tue":…} and {"tue":…} resolve.
//
// Exported for the admin edge, which has to refuse what this cannot match. Every value check passes
// a key like "Modnay", and the shop is then shut on Mondays for good — the agent turns bookings
// away and tells callers it is closed, with nothing anywhere saying why.
export function isValidHoursKey(key: string): boolean {
  const parts = key.split('-');
  if (parts.length > 2) return false;
  return parts.every((part) => dayIndexFromName(part) >= 0);
}

export function keyMatchesDay(key: string, dayIndex: number): boolean {
  const [firstDay, lastDay] = key.split('-');
  if (!firstDay) return false;
  const from = dayIndexFromName(firstDay);
  if (from < 0) return false;
  if (!lastDay) return from === dayIndex;
  const to = dayIndexFromName(lastDay);
  if (to < 0) return false;
  return from <= to ? dayIndex >= from && dayIndex <= to : dayIndex >= from || dayIndex <= to;
}

export function parseTime(s: string): number {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m || !m[1] || !m[3]) return -1;
  let h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2] ?? '0', 10);
  const period = m[3].toLowerCase();
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

export function getHoursForDate(
  hoursJson: string,
  dateStr: string,
): { open: number; close: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(hoursJson);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) return null;

  const dayIndex = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const entries = Object.entries(parsed as Record<string, unknown>);

  // A key naming this day outright beats a range that merely covers it, and the key that wins
  // settles the day — "closed" included. Both rules exist to take the answer away from JSON key
  // order: {"Sun":"closed","Sat-Sun":"9am-4pm"} used to open on Sunday or not depending on which
  // key was written first, and nobody writes that order deliberately.
  const match =
    entries.find(([key]) => !key.includes('-') && dayIndexFromName(key) === dayIndex) ??
    entries.find(([key]) => keyMatchesDay(key, dayIndex));
  if (!match || typeof match[1] !== 'string') return null;

  const [openStr, closeStr] = match[1].split('-');
  if (!openStr || !closeStr) return null;
  const open = parseTime(openStr);
  const close = parseTime(closeStr);
  return open >= 0 && close > open ? { open, close } : null;
}

// A staff member's own hours narrow the shop's, never widen them. No own hours means
// the shop's hours apply unchanged. Null means the member isn't working that day.
export function getStaffHoursForDate(
  shop: ShopRow,
  member: StaffMember | undefined,
  dateStr: string,
): { open: number; close: number } | null {
  const shopHours = getHoursForDate(shop.hours_json, dateStr);
  if (!shopHours || !member?.hours) return shopHours;
  const own = getHoursForDate(JSON.stringify(member.hours), dateStr);
  if (!own) return null;
  const open = Math.max(shopHours.open, own.open);
  const close = Math.min(shopHours.close, own.close);
  return close > open ? { open, close } : null;
}

export function isClosed(closuresJson: string, dateStr: string): boolean {
  try {
    const parsed = JSON.parse(closuresJson);
    if (Array.isArray(parsed)) return parsed.map(String).includes(dateStr);
  } catch {}
  return false;
}

export function tzOffsetMinutes(dateStr: string, timezone: string): number {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const offsetStr = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number.parseInt(m[2] ?? '0', 10) * 60 + Number.parseInt(m[3] ?? '0', 10));
}

export function offsetLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// Render a UTC instant as an ISO string in the shop's local offset, so the digits the
// agent reads are the local clock time it should speak and book.
export function localIso(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, offsetLabel(offsetMin));
}

export function spokenTimeLabel(utcMs: number, timezone: string): string {
  return new Date(utcMs).toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The shop's UTC offset (minutes) on the local day of `utcMs` — DST-correct per date.
export function localOffsetFor(utcMs: number, timezone: string): number {
  const localDate = new Date(utcMs).toLocaleDateString('en-CA', { timeZone: timezone });
  return tzOffsetMinutes(localDate, timezone);
}

export function spokenDateTimeLabel(utcMs: number, timezone: string): string {
  const time = spokenTimeLabel(utcMs, timezone);
  const dateLocal = new Date(utcMs).toLocaleDateString('en-CA', { timeZone: timezone });
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const tomorrowLocal = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', {
    timeZone: timezone,
  });
  if (dateLocal === todayLocal) return `today at ${time}`;
  if (dateLocal === tomorrowLocal) return `tomorrow at ${time}`;
  const day = new Date(utcMs).toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return `${day} at ${time}`;
}

export type BookingTimeReason = 'invalid' | 'past' | 'closed' | 'outside_hours' | 'staff_away';

export type BookingTimeValidation = { ok: true } | { ok: false; reason: BookingTimeReason };

// Server-side guard: a booking time must be parseable, in the future, on an open day,
// inside the shop's hours, and inside the chosen staff member's own hours if they have
// any. Defends against a mis-read or hallucinated time.
export function validateBookingTime(
  shop: ShopRow,
  startIso: string,
  durationMin: number,
  member?: StaffMember,
): BookingTimeValidation {
  const startMs = new Date(startIso).getTime();
  if (Number.isNaN(startMs)) return { ok: false, reason: 'invalid' };
  if (startMs <= Date.now()) return { ok: false, reason: 'past' };

  const dateStr = new Date(startMs).toLocaleDateString('en-CA', { timeZone: shop.timezone });
  if (isClosed(shop.closures_json, dateStr)) return { ok: false, reason: 'closed' };

  const hours = getHoursForDate(shop.hours_json, dateStr);
  if (!hours) return { ok: false, reason: 'closed' };

  const offsetMin = tzOffsetMinutes(dateStr, shop.timezone);
  const midnight = new Date(`${dateStr}T00:00:00Z`).getTime();
  const localMin = (startMs - midnight) / 60_000 + offsetMin;
  if (localMin < hours.open || localMin + durationMin > hours.close) {
    return { ok: false, reason: 'outside_hours' };
  }

  if (member?.hours) {
    const own = getStaffHoursForDate(shop, member, dateStr);
    if (!own || localMin < own.open || localMin + durationMin > own.close) {
      return { ok: false, reason: 'staff_away' };
    }
  }
  return { ok: true };
}
