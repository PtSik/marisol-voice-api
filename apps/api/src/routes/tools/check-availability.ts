import type { Context } from 'hono';
import type {
  WorkerBindings,
  ShopRow,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  CheckAvailabilityParams,
  AvailableSlot,
} from '../../types';
import { getSupabase } from '../../lib/supabase';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseTime(s: string): number {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m || !m[1] || !m[3]) return -1;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] ?? '0', 10);
  const period = m[3].toLowerCase();
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

function getHoursForDate(hoursJson: string, dateStr: string): { open: number; close: number } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(hoursJson); } catch { return null; }

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
        match = from <= to ? dayIndex >= from && dayIndex <= to : dayIndex >= from || dayIndex <= to;
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

function conflicts(
  s1: number,
  s2: number,
  staffName: string,
  booked: Array<{ start_at: string; end_at: string; staff: string }>,
): boolean {
  for (const b of booked) {
    if (b.staff !== staffName) continue;
    const b1 = new Date(b.start_at).getTime();
    const b2 = new Date(b.end_at).getTime();
    if (b1 < s2 && b2 > s1) return true;
  }
  return false;
}

function tzOffsetMinutes(dateStr: string, timezone: string): number {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(probe);
  const offsetStr = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = offsetStr.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (parseInt(m[2] ?? '0', 10) * 60 + parseInt(m[3] ?? '0', 10));
}

export async function handleCheckAvailability(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<CheckAvailabilityParams | ElevenLabsToolWebhookRequest<CheckAvailabilityParams>>();
  const params = ('parameters' in raw ? raw.parameters : raw) as CheckAvailabilityParams;
  const { date, duration_minutes = 30, staff } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ElevenLabsToolWebhookResponse>({ result: 'Invalid date format. Use YYYY-MM-DD.', success: false });
  }

  const hours = getHoursForDate(shop.hours_json, date);
  if (!hours) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'The shop is closed on that day.',
      success: true,
      data: { available_slots: [], total_available: 0, date },
    });
  }

  const db = getSupabase(c.env);
  const { data: booked } = await db
    .from('bookings')
    .select('start_at, end_at, staff')
    .eq('shop_id', shop.id)
    .eq('status', 'confirmed')
    .gte('start_at', `${date}T00:00:00+00:00`)
    .lte('start_at', `${date}T23:59:59+00:00`);

  let staffList: string[];
  try {
    const p = JSON.parse(shop.staff_json);
    staffList = Array.isArray(p) ? p.map(String) : [];
  } catch {
    staffList = [];
  }

  const bookings = booked ?? [];
  const targets = staff && staff !== 'any' ? [staff] : staffList;
  const slots: AvailableSlot[] = [];
  const nowMs = Date.now();
  const offsetMin = tzOffsetMinutes(date, shop.timezone);
  const midnight = new Date(`${date}T00:00:00Z`).getTime();

  for (let t = hours.open; t + duration_minutes <= hours.close; t += duration_minutes) {
    // Convert local minutes-from-midnight to UTC milliseconds
    const s1 = midnight + (t - offsetMin) * 60_000;
    const s2 = s1 + duration_minutes * 60_000;
    if (s2 <= nowMs) continue; // skip past slots
    const slotStart = new Date(s1).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const slotEnd = new Date(s2).toISOString().replace(/\.\d{3}Z$/, 'Z');

    for (const s of targets) {
      if (!conflicts(s1, s2, s, bookings)) {
        slots.push({ start_time: slotStart, end_time: slotEnd, staff_name: s });
        if (!staff || staff === 'any') break;
      }
    }
  }

  return c.json<ElevenLabsToolWebhookResponse>({
    result: slots.length > 0 ? `Found ${slots.length} available slots on ${date}.` : `No available slots on ${date}.`,
    success: true,
    data: { available_slots: slots, total_available: slots.length, date },
  });
}
