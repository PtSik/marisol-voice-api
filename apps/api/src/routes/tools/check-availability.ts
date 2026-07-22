import type { Context } from 'hono';
import { getGCalBusy } from '../../lib/gcal';
import {
  getHoursForDate,
  getStaffHoursForDate,
  isClosed,
  localIso,
  spokenTimeLabel,
  tzOffsetMinutes,
} from '../../lib/hours';
import { type StaffMember, normalizeStaffName, parseStaff } from '../../lib/staff';
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

export function buildSlots(input: {
  shop: ShopRow;
  date: string;
  durationMinutes: number;
  shopHours: { open: number; close: number };
  requestedStaff: string | undefined;
  bookings: Array<{ start_at: string; end_at: string; staff: string }>;
  foreignBusy: Array<{ start: number; end: number }>;
}): AvailableSlot[] {
  const { shop, date, durationMinutes, shopHours, bookings, foreignBusy } = input;
  const requested =
    input.requestedStaff && input.requestedStaff !== 'any'
      ? normalizeStaffName(input.requestedStaff)
      : null;
  const staffList = parseStaff(shop.staff_json);
  // An unknown name still resolves — a shop may take bookings for someone not listed.
  const candidates: StaffMember[] = requested
    ? [
        staffList.find((m) => m.name.toLowerCase() === requested.toLowerCase()) ?? {
          id: '',
          name: requested,
        },
      ]
    : staffList;
  // Staff on a narrower schedule than the shop only get their own window; anyone off
  // that day drops out entirely.
  const targets = candidates
    .map((m) => ({ member: m, hours: getStaffHoursForDate(shop, m, date) }))
    .filter((t): t is { member: StaffMember; hours: { open: number; close: number } } => !!t.hours);

  const slots: AvailableSlot[] = [];
  const nowMs = Date.now();
  const offsetMin = tzOffsetMinutes(date, shop.timezone);
  const midnight = new Date(`${date}T00:00:00Z`).getTime();

  // The grid is anchored on the shop's opening time so every staff member is offered the
  // same clock times; each member's own window only trims which of them they can take.
  for (let t = shopHours.open; t + durationMinutes <= shopHours.close; t += durationMinutes) {
    // Convert local minutes-from-midnight to UTC milliseconds
    const s1 = midnight + (t - offsetMin) * 60_000;
    const s2 = s1 + durationMinutes * 60_000;
    if (s1 <= nowMs) continue; // skip slots that have already started
    if (foreignBusy.some((b) => b.start < s2 && b.end > s1)) continue; // blocked by a foreign calendar event
    // Emit times in the shop's local offset so the digits the agent reads are the local
    // clock time it should speak and book — not a UTC value it would misread.
    const slotStart = localIso(s1, offsetMin);
    const slotEnd = localIso(s2, offsetMin);
    const label = spokenTimeLabel(s1, shop.timezone);

    for (const { member, hours: own } of targets) {
      if (t < own.open || t + durationMinutes > own.close) continue;
      if (!conflicts(s1, s2, member.name, bookings)) {
        slots.push({ start_time: slotStart, end_time: slotEnd, staff_name: member.name, label });
        if (!requested) break;
      }
    }
  }
  return slots;
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
  const [{ data: booked }, gcalBusy] = await Promise.all([
    db
      .from('bookings')
      .select('start_at, end_at, staff, gcal_event_id')
      .eq('shop_id', shop.id)
      .eq('status', 'confirmed')
      .gte('start_at', winStart)
      .lt('start_at', winEnd),
    getGCalBusy(c.env, shop, winStart, winEnd),
  ]);

  const bookings = booked ?? [];
  // Our own bookings are mirrored into GCal (gcal_event_id); exclude them so a foreign event
  // (Booksy / manual) blocks all staff while our own only blocks the booked staff via conflicts().
  const ownEventIds = new Set(
    bookings.map((b) => b.gcal_event_id).filter((id): id is string => !!id),
  );
  const foreignBusy = gcalBusy.filter((b) => !ownEventIds.has(b.id));

  const slots = buildSlots({
    shop,
    date,
    durationMinutes: duration_minutes,
    shopHours: hours,
    requestedStaff: staff,
    bookings,
    foreignBusy,
  });

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
