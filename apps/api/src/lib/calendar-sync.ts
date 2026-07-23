import type {
  BookingRow,
  CalendarRouting,
  CalendarSyncStateRow,
  ShopRow,
  WorkerBindings,
} from '../types';
import { logGcalFailure, logGcalMoveConflict } from './calendar-alerts';
import {
  type GCalDeltaEvent,
  GCalHttpError,
  deterministicEventId,
  gcalCreateEvent,
  gcalDeleteEvent,
  gcalGetEvent,
  gcalListDeltas,
  gcalPatchEvent,
  getGCalClient,
  resolveRouting,
  writeCalendarFor,
} from './gcal';
import { findStaff } from './staff';
import { getSupabase } from './supabase';

// Leaves an in-flight waitUntil alone: the flag is set before the calendar call, so a row
// younger than this may simply not have finished its happy path yet.
const REPAIR_GRACE_MS = 5 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = ReturnType<typeof getSupabase>;

export type DeltaAction =
  | { type: 'none' }
  | { type: 'cancel' }
  | { type: 'move'; startIso: string; endIso: string };

// 'skipped' covers the two outcomes we deliberately never retry: a lost compare-and-set
// (the winning writer updates the calendar itself, so a fresh delta follows) and a move
// rejected by the GiST constraint (logged and alerted — a human has to resolve it).
// 'failed' is an unexpected write error, and the sync token must not advance past it.
type DeltaOutcome = 'applied' | 'skipped' | 'failed';

// A delta always carries the resource's current state, so a delta that agrees with the
// booking is our own write echoing back — never apply it. Title/description edits and
// conversions to all-day (no dateTime) are deliberately ignored.
export function planDeltaAction(
  booking: Pick<BookingRow, 'status' | 'start_at' | 'end_at'>,
  event: GCalDeltaEvent,
): DeltaAction {
  if (event.status === 'cancelled') {
    return booking.status === 'confirmed' ? { type: 'cancel' } : { type: 'none' };
  }
  if (booking.status !== 'confirmed') return { type: 'none' };
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end) return { type: 'none' };
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { type: 'none' };
  if (startMs === Date.parse(booking.start_at) && endMs === Date.parse(booking.end_at)) {
    return { type: 'none' };
  }
  return {
    type: 'move',
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

// Calendars our events can live in: the write targets from routing, plus any calendar a
// future booking was written to before the mapping changed. Busy-only calendars are
// skipped — we never write there, so their deltas could only be ignored.
export function syncCalendarsFor(
  routing: CalendarRouting,
  bookingCalendarIds: Array<string | null>,
): string[] {
  return [
    ...new Set([
      routing.write_calendar_id,
      ...Object.values(routing.staff_calendars),
      ...bookingCalendarIds.filter((id): id is string => !!id),
    ]),
  ];
}

export async function runCalendarSync(
  env: WorkerBindings,
  nowMs = Date.now(),
): Promise<{ shops: number; applied: number; repaired: number }> {
  const db = getSupabase(env);
  const { data: shops, error } = await db
    .from('shops')
    .select('*')
    .eq('integration', 'google_calendar')
    .not('integration_credentials_encrypted', 'is', null);
  if (error || !shops) {
    console.log('[gcal-sync] shops select error:', error?.message);
    return { shops: 0, applied: 0, repaired: 0 };
  }

  let applied = 0;
  let repaired = 0;
  const results = await Promise.allSettled(
    shops.map((shop) => syncShop(env, db, shop as ShopRow, nowMs)),
  );
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      applied += result.value.applied;
      repaired += result.value.repaired;
      return;
    }
    const shop = shops[i] as ShopRow | undefined;
    console.error(`[gcal-sync] shop ${shop?.id} failed:`, errorMessage(result.reason));
  });
  return { shops: shops.length, applied, repaired };
}

async function syncShop(
  env: WorkerBindings,
  db: Db,
  shop: ShopRow,
  nowMs: number,
): Promise<{ applied: number; repaired: number }> {
  if (!shop.integration_credentials_encrypted) return { applied: 0, repaired: 0 };

  let token: string;
  try {
    ({ token } = await getGCalClient(env, shop.integration_credentials_encrypted));
  } catch (err) {
    await logGcalFailure(env, shop.id, { op: 'token', message: errorMessage(err) });
    return { applied: 0, repaired: 0 };
  }

  const routing = resolveRouting(shop);
  const { data: calRows } = await db
    .from('bookings')
    .select('gcal_calendar_id')
    .eq('shop_id', shop.id)
    .eq('status', 'confirmed')
    .gte('start_at', new Date(nowMs).toISOString())
    .not('gcal_calendar_id', 'is', null);
  const calendars = syncCalendarsFor(
    routing,
    (calRows ?? []).map((r) => r.gcal_calendar_id as string | null),
  );

  const { data: stateRows } = await db
    .from('calendar_sync_state')
    .select('*')
    .eq('shop_id', shop.id);
  const tokenByCalendar = new Map(
    ((stateRows ?? []) as CalendarSyncStateRow[]).map((s) => [s.calendar_id, s.sync_token]),
  );

  let applied = 0;
  for (const calendarId of calendars) {
    try {
      applied += await syncCalendar(
        env,
        db,
        shop,
        token,
        calendarId,
        tokenByCalendar.get(calendarId) ?? null,
        nowMs,
      );
    } catch (err) {
      await logGcalFailure(env, shop.id, {
        op: 'sync',
        calendar_id: calendarId,
        message: errorMessage(err),
      });
    }
  }

  const repaired = await repairShop(env, db, shop, token, nowMs);
  return { applied, repaired };
}

export async function syncCalendar(
  env: WorkerBindings,
  db: Db,
  shop: ShopRow,
  token: string,
  calendarId: string,
  storedSyncToken: string | null,
  nowMs: number,
): Promise<number> {
  let collected: { events: GCalDeltaEvent[]; nextSyncToken?: string };
  try {
    collected = await collectDeltas(calendarId, token, storedSyncToken, nowMs);
  } catch (err) {
    if (!(err instanceof GCalHttpError) || err.status !== 410) throw err;
    // Expired sync token — full resync from now; anything already reconciled just echoes.
    collected = await collectDeltas(calendarId, token, null, nowMs);
  }

  let applied = 0;
  let failed = false;
  if (collected.events.length > 0) {
    const bookings = await matchBookings(db, shop.id, collected.events);
    for (const { booking, event } of bookings) {
      const action = planDeltaAction(booking, event);
      if (action.type === 'none') continue;
      const outcome = await applyDelta(env, db, shop, calendarId, booking, action);
      if (outcome === 'applied') applied++;
      else if (outcome === 'failed') failed = true;
    }
  }

  // Google never replays a consumed delta, so committing the token after a failed write
  // would drop that change for good. Holding the old token costs one repeated (idempotent)
  // batch next tick; advancing it costs a booking that silently disagrees with the calendar.
  if (failed) {
    console.log(`[gcal-sync] holding sync token for ${calendarId} — a delta failed to apply`);
    return applied;
  }

  if (collected.nextSyncToken) {
    await db.from('calendar_sync_state').upsert({
      shop_id: shop.id,
      calendar_id: calendarId,
      sync_token: collected.nextSyncToken,
      synced_at: new Date(nowMs).toISOString(),
    });
  }
  return applied;
}

async function collectDeltas(
  calendarId: string,
  token: string,
  syncToken: string | null,
  nowMs: number,
): Promise<{ events: GCalDeltaEvent[]; nextSyncToken?: string }> {
  const events: GCalDeltaEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const page = await gcalListDeltas(calendarId, token, {
      ...(syncToken ? { syncToken } : { timeMinIso: new Date(nowMs).toISOString() }),
      ...(pageToken ? { pageToken } : {}),
    });
    events.push(...page.events);
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  return { events, ...(nextSyncToken ? { nextSyncToken } : {}) };
}

// Deltas map to bookings by marisol_booking_id with a fallback on the raw event id (a
// deleted event's delta can be a bare skeleton). Anything unmatched is a foreign event —
// recurring masters included — and is ignored.
async function matchBookings(
  db: Db,
  shopId: string,
  events: GCalDeltaEvent[],
): Promise<Array<{ booking: BookingRow; event: GCalDeltaEvent }>> {
  const byBookingId = new Map<string, GCalDeltaEvent>();
  const byEventId = new Map<string, GCalDeltaEvent>();
  for (const event of events) {
    if (event.bookingId && UUID_RE.test(event.bookingId)) byBookingId.set(event.bookingId, event);
    byEventId.set(event.id, event);
  }

  const [idRows, eventIdRows] = await Promise.all([
    selectIn(db, shopId, 'id', [...byBookingId.keys()]),
    selectIn(db, shopId, 'gcal_event_id', [...byEventId.keys()]),
  ]);

  const matched = new Map<string, { booking: BookingRow; event: GCalDeltaEvent }>();
  for (const row of [...idRows, ...eventIdRows]) {
    if (matched.has(row.id)) continue;
    const event =
      byBookingId.get(row.id) ?? (row.gcal_event_id ? byEventId.get(row.gcal_event_id) : undefined);
    if (event) matched.set(row.id, { booking: row, event });
  }
  return [...matched.values()];
}

// A first sync of a busy calendar hands us every event it holds, foreign ones included, so
// the id list goes into the PostgREST query string in batches — one `in.(…)` with thousands
// of ids comes back as a 414 and takes the whole calendar's tick down with it.
const MATCH_CHUNK = 100;

async function selectIn(
  db: Db,
  shopId: string,
  column: 'id' | 'gcal_event_id',
  values: string[],
): Promise<BookingRow[]> {
  const rows: BookingRow[] = [];
  for (let i = 0; i < values.length; i += MATCH_CHUNK) {
    const { data } = await db
      .from('bookings')
      .select('*')
      .eq('shop_id', shopId)
      .in(column, values.slice(i, i + MATCH_CHUNK));
    rows.push(...((data ?? []) as BookingRow[]));
  }
  return rows;
}

// Compare-and-set on the fields we actually read — not on updated_at, which has no trigger
// and relies on writers remembering to bump it. A delta that loses the race with a fresher
// phone-made change becomes a no-op; the next tick reconciles from a new delta.
export async function applyDelta(
  env: WorkerBindings,
  db: Db,
  shop: ShopRow,
  calendarId: string,
  booking: BookingRow,
  action: Exclude<DeltaAction, { type: 'none' }>,
): Promise<DeltaOutcome> {
  const cas = (update: Record<string, unknown>) =>
    db
      .from('bookings')
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('start_at', booking.start_at)
      .eq('end_at', booking.end_at)
      .select('id');

  if (action.type === 'cancel') {
    // No SMS to the customer — the owner cancelled by hand and reaches out themselves.
    const { data, error } = await cas({ status: 'cancelled', cancelled_via: 'calendar' });
    if (error) {
      console.log('[gcal-sync] cancel apply error:', error.message);
      return 'failed';
    }
    return (data ?? []).length > 0 ? 'applied' : 'skipped';
  }

  const { data, error } = await cas({ start_at: action.startIso, end_at: action.endIso });
  if (error) {
    if (error.code === '23P01') {
      await logGcalMoveConflict(env, shop.id, {
        booking_id: booking.id,
        calendar_id: calendarId,
        start_at: action.startIso,
        end_at: action.endIso,
      });
      return 'skipped';
    }
    console.log('[gcal-sync] move apply error:', error.message);
    return 'failed';
  }
  return (data ?? []).length > 0 ? 'applied' : 'skipped';
}

// Supabase → calendar repair: only our own silent write failures. A human deleting our
// event is a cancellation signal handled by the sync pass above and is never resurrected.
async function repairShop(
  env: WorkerBindings,
  db: Db,
  shop: ShopRow,
  token: string,
  nowMs: number,
): Promise<number> {
  const { data: rows } = await db
    .from('bookings')
    .select('*')
    .eq('shop_id', shop.id)
    .eq('gcal_sync_pending', true)
    .lt('updated_at', new Date(nowMs - REPAIR_GRACE_MS).toISOString());
  const pending = (rows ?? []) as BookingRow[];

  let repaired = 0;
  for (const booking of pending) {
    try {
      if (await repairBooking(env, db, shop, token, booking)) repaired++;
    } catch (err) {
      await logGcalFailure(env, shop.id, {
        op: 'write',
        ...(booking.gcal_calendar_id ? { calendar_id: booking.gcal_calendar_id } : {}),
        message: errorMessage(err),
      });
    }
  }
  return repaired;
}

export async function repairBooking(
  env: WorkerBindings,
  db: Db,
  shop: ShopRow,
  token: string,
  booking: BookingRow,
): Promise<boolean> {
  const member = findStaff(shop.staff_json, booking.staff);
  const fallbackCalendarId = booking.gcal_calendar_id ?? writeCalendarFor(shop, member?.id);

  if (booking.status === 'confirmed' && !booking.gcal_event_id) {
    return createMissingEvent(db, shop, token, booking, member);
  }

  if (booking.status === 'confirmed' && booking.gcal_event_id) {
    const eventId = booking.gcal_event_id;
    try {
      await gcalPatchEvent(
        fallbackCalendarId,
        token,
        eventId,
        booking.start_at,
        booking.end_at,
        shop.timezone,
      );
    } catch (err) {
      if (!(err instanceof GCalHttpError) || (err.status !== 404 && err.status !== 410)) throw err;
      return patchTargetGone(db, fallbackCalendarId, token, booking, eventId);
    }
    await clearPending(db, booking.id, {});
    return true;
  }

  if (booking.status === 'cancelled') {
    // Even without a stored gcal_event_id the event may exist: create succeeded, the DB
    // write of the id was lost, then the caller cancelled by phone. The deterministic id
    // reaches that orphan; deleting a never-created id is a 404, which delete treats as done.
    const eventId = booking.gcal_event_id ?? deterministicEventId(booking.id);
    await gcalDeleteEvent(fallbackCalendarId, token, eventId);
    await clearPending(db, booking.id, { gcal_event_id: null });
    return true;
  }

  await clearPending(db, booking.id, {});
  return true;
}

// A patch that finds nothing is ambiguous the same way a 409 on insert is, and is settled the
// same way — with events.get. Google never frees an id, so a deleted event still answers as
// 'cancelled'; a null answer means this id was never in *this* calendar (the routing moved
// under us), not that it was deleted. Left unhandled, either case pins the flag up forever
// and alerts the shop every hour.
async function patchTargetGone(
  db: Db,
  calendarId: string,
  token: string,
  booking: BookingRow,
  eventId: string,
): Promise<boolean> {
  const existing = await gcalGetEvent(calendarId, token, eventId);

  if (existing?.status === 'cancelled') {
    // Human cancellation, same as the sync pass reads it: never resurrected, no SMS.
    await db
      .from('bookings')
      .update({
        status: 'cancelled',
        cancelled_via: 'calendar',
        gcal_sync_pending: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', booking.id)
      .eq('status', 'confirmed');
    return true;
  }

  // Wrong calendar: drop the stale pointer and let the next tick create the event where the
  // routing points now. The deterministic id keeps that retry from duplicating anything, and
  // a 409 there re-runs the same disambiguation.
  await db
    .from('bookings')
    .update({ gcal_event_id: null, gcal_calendar_id: null })
    .eq('id', booking.id)
    .eq('status', 'confirmed');
  return false;
}

async function createMissingEvent(
  db: Db,
  shop: ShopRow,
  token: string,
  booking: BookingRow,
  member: ReturnType<typeof findStaff>,
): Promise<boolean> {
  const calendarId = writeCalendarFor(shop, member?.id);
  const eventId = deterministicEventId(booking.id);
  try {
    await gcalCreateEvent(
      calendarId,
      token,
      `${booking.service ?? 'Appointment'} — ${booking.customer_name ?? booking.customer_phone} (${member?.name ?? booking.staff})`,
      `Phone: ${booking.customer_phone}\nService: ${booking.service ?? 'N/A'}`,
      booking.start_at,
      booking.end_at,
      shop.timezone,
      booking.id,
      eventId,
    );
    await clearPending(db, booking.id, { gcal_event_id: eventId, gcal_calendar_id: calendarId });
    return true;
  } catch (err) {
    if (!(err instanceof GCalHttpError) || err.status !== 409) throw err;
    // 409 is ambiguous — Google never frees an id, so a deleted event also collides.
    // events.get is the only reliable disambiguation: a skeleton deletion delta plus a
    // lost create response means sync could never map the cancellation.
    const existing = await gcalGetEvent(calendarId, token, eventId);
    if (!existing) throw err;
    if (existing.status !== 'cancelled') {
      // The original create worked; only the DB write of the id was lost. Adopt it.
      await clearPending(db, booking.id, { gcal_event_id: eventId, gcal_calendar_id: calendarId });
      return true;
    }
    // Create worked and the owner already deleted the event — that's a human cancellation,
    // not a failure. Never resurrect the event; no SMS.
    await db
      .from('bookings')
      .update({
        status: 'cancelled',
        cancelled_via: 'calendar',
        gcal_event_id: eventId,
        gcal_calendar_id: calendarId,
        gcal_sync_pending: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', booking.id)
      .eq('status', 'confirmed');
    return true;
  }
}

async function clearPending(
  db: Db,
  bookingId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await db
    .from('bookings')
    .update({ ...extra, gcal_sync_pending: false })
    .eq('id', bookingId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
