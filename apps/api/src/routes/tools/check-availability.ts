import type { Context } from 'hono';
import {
  getHoursForDate,
  isClosed,
  localIso,
  spokenTimeLabel,
  tzOffsetMinutes,
} from '../../lib/hours';
import { getSupabase } from '../../lib/supabase';
import type {
  AvailableSlot,
  CheckAvailabilityParams,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  ShopRow,
  WorkerBindings,
} from '../../types';

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

export async function handleCheckAvailability(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    CheckAvailabilityParams | ElevenLabsToolWebhookRequest<CheckAvailabilityParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as CheckAvailabilityParams;
  const { date, duration_minutes = 30, staff } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'Invalid date format. Use YYYY-MM-DD.',
      success: false,
    });
  }

  if (isClosed(shop.closures_json, date)) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'The shop is closed on that day.',
      success: true,
      data: { available_slots: [], total_available: 0, date },
    });
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
  // Widen the query window by a day on each side: a slot local to `date` can fall on the
  // adjacent UTC date in extreme timezones. conflicts() filters by exact overlap, so
  // over-fetching is harmless.
  const dayStartUtc = new Date(`${date}T00:00:00Z`).getTime();
  const winStart = new Date(dayStartUtc - 24 * 60 * 60_000).toISOString();
  const winEnd = new Date(dayStartUtc + 48 * 60 * 60_000).toISOString();
  const { data: booked } = await db
    .from('bookings')
    .select('start_at, end_at, staff')
    .eq('shop_id', shop.id)
    .eq('status', 'confirmed')
    .gte('start_at', winStart)
    .lt('start_at', winEnd);

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
    if (s1 <= nowMs) continue; // skip slots that have already started
    // Emit times in the shop's local offset so the digits the agent reads are the local
    // clock time it should speak and book — not a UTC value it would misread.
    const slotStart = localIso(s1, offsetMin);
    const slotEnd = localIso(s2, offsetMin);
    const label = spokenTimeLabel(s1, shop.timezone);

    for (const s of targets) {
      if (!conflicts(s1, s2, s, bookings)) {
        slots.push({ start_time: slotStart, end_time: slotEnd, staff_name: s, label });
        if (!staff || staff === 'any') break;
      }
    }
  }

  const soonest = slots[0]?.label;
  return c.json<ElevenLabsToolWebhookResponse>({
    result:
      slots.length > 0
        ? `Found ${slots.length} available slots on ${date}, soonest at ${soonest}.`
        : `No available slots on ${date}.`,
    success: true,
    data: { available_slots: slots, total_available: slots.length, date },
  });
}
