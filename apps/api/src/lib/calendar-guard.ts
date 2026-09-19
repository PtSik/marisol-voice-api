import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShopRow, WorkerBindings } from '../types';
import { splitByAttribution } from './attribution';
import { getStaffBusy, resolveRouting } from './gcal';
import type { StaffMember } from './staff';

// Three outcomes, not a boolean: `unavailable` means we could not read the calendar and must
// refuse the whole operation, while `clear` and `blocked` are ordinary answers the caller
// words for itself — booking and reschedule say different things about the original slot.
export type CalendarGuard = 'clear' | 'blocked' | 'unavailable';

export interface CalendarGuardInput {
  startAt: string;
  endAt: string;
  // Whose slot this is, when the shop has a roster. A per-person calendar blocks only them;
  // the shared calendar blocks everyone.
  member: StaffMember | undefined;
  // Already parsed by the caller — parsing staff_json again here would be a third pass.
  roster: StaffMember[];
  // Events that are ours and must not block us. Reschedule passes the booking's current
  // event: the DB overlap query cannot find it when the new slot does not overlap the old.
  ignoreEventIds?: readonly string[];
  waitUntil: (promise: Promise<unknown>) => void;
}

// The GiST EXCLUDE constraint only catches our own bookings, so a foreign event (Booksy, a
// manual entry) needs this read to be caught at all. Our own mirrored events are filtered out
// of both collections by id; letting one of them block us would refuse a slot the database
// is already the authority on.
export async function checkCalendarConflict(
  env: WorkerBindings,
  db: SupabaseClient,
  shop: ShopRow,
  input: CalendarGuardInput,
): Promise<CalendarGuard> {
  const [own, busy] = await Promise.all([
    db
      .from('bookings')
      .select('gcal_event_id')
      .eq('shop_id', shop.id)
      .eq('status', 'confirmed')
      .lt('start_at', input.endAt)
      .gt('end_at', input.startAt),
    getStaffBusy(env, shop, input.startAt, input.endAt, { waitUntil: input.waitUntil }),
  ]);
  if (own.error || busy.unavailable) return 'unavailable';

  const ownIds = new Set<string>(input.ignoreEventIds ?? []);
  for (const booking of own.data ?? []) {
    if (booking.gcal_event_id) ownIds.add(booking.gcal_event_id);
  }
  const notOurs = (event: { id: string }) => !ownIds.has(event.id);

  const foreign = splitByAttribution(
    busy.shared.filter(notOurs),
    Object.fromEntries(
      Object.entries(busy.perStaff).map(([id, events]) => [id, events.filter(notOurs)]),
    ),
    resolveRouting(shop).attribution,
    input.roster,
  );

  const startMs = new Date(input.startAt).getTime();
  const endMs = new Date(input.endAt).getTime();
  const blocking = [
    ...foreign.shared,
    ...(input.member ? (foreign.perStaff[input.member.id] ?? []) : []),
  ];
  return blocking.some((b) => b.start < endMs && b.end > startMs) ? 'blocked' : 'clear';
}
