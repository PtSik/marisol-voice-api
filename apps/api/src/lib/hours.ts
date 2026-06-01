import type { ShopRow } from '../types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  if (typeof parsed === 'string') {
    const [openStr, closeStr] = parsed.split('-');
    if (!openStr || !closeStr) return null;
    const open = parseTime(openStr);
    const close = parseTime(closeStr);
    return open >= 0 && close > open ? { open, close } : null;
  }

  if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) return null;

  const dayIndex = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const dayName = DAY_NAMES[dayIndex];
  if (!dayName) return null;

  for (const [key, value] of Object.entries(parsed as Record<string, string>)) {
    const [firstDay, lastDay] = key.split('-');
    if (!firstDay) continue;

    let match = false;
    if (!lastDay) {
      match = firstDay.trim() === dayName;
    } else {
      const from = DAY_NAMES.indexOf(firstDay.trim());
      const to = DAY_NAMES.indexOf(lastDay.trim());
      if (from >= 0 && to >= 0) {
        match =
          from <= to ? dayIndex >= from && dayIndex <= to : dayIndex >= from || dayIndex <= to;
      }
    }

    if (match) {
      const [openStr, closeStr] = value.split('-');
      if (!openStr || !closeStr) continue;
      const open = parseTime(openStr);
      const close = parseTime(closeStr);
      if (open >= 0 && close > open) return { open, close };
    }
  }
  return null;
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

export type BookingTimeValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'past' | 'closed' | 'outside_hours' };

// Server-side guard: a booking time must be parseable, in the future, on an open day,
// and inside the shop's hours. Defends against a mis-read or hallucinated time.
export function validateBookingTime(
  shop: ShopRow,
  startIso: string,
  durationMin: number,
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
  return { ok: true };
}
