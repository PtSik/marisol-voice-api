import type { Context } from 'hono';
import { localIso, localOffsetFor, spokenDateTimeLabel } from '../../lib/hours';
import { tryToE164 } from '../../lib/normalize';
import { getSupabase } from '../../lib/supabase';
import type {
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  LookupCustomerParams,
  ShopRow,
  WorkerBindings,
} from '../../types';

function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const item of arr) counts[item] = (counts[item] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export async function handleLookupCustomer(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    LookupCustomerParams | ElevenLabsToolWebhookRequest<LookupCustomerParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as LookupCustomerParams;
  const { phone_number } = params;

  const normalized = tryToE164(phone_number);
  if (!normalized) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'Invalid phone number.',
      success: false,
    });
  }

  const db = getSupabase(c.env);
  const { data: bookings } = await db
    .from('bookings')
    .select('id, start_at, end_at, service, staff, status, customer_name')
    .eq('shop_id', shop.id)
    .eq('customer_phone', normalized)
    .order('start_at', { ascending: false });

  if (!bookings || bookings.length === 0) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'No customer record found for that phone number.',
      success: true,
      data: { found: false },
    });
  }

  const latest = bookings[0];
  if (!latest) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'No customer record found for that phone number.',
      success: true,
      data: { found: false },
    });
  }

  const nowIso = new Date().toISOString();
  // Actual visits = completed/confirmed bookings already in the past. bookings is ordered
  // start_at desc, so past[0] is the most recent real visit.
  const past = bookings.filter(
    (b) => (b.status === 'completed' || b.status === 'confirmed') && b.start_at < nowIso,
  );
  const upcoming = bookings
    .filter((b) => b.status === 'confirmed' && b.start_at > nowIso)
    .map((b) => {
      const startMs = new Date(b.start_at).getTime();
      const off = localOffsetFor(startMs, shop.timezone);
      return {
        booking_id: b.id,
        start_at: localIso(startMs, off),
        end_at: localIso(new Date(b.end_at).getTime(), off),
        service: b.service,
        staff: b.staff,
        // Spoken local date+time — read this back to the caller, never the raw timestamp.
        label: spokenDateTimeLabel(startMs, shop.timezone),
      };
    });

  const lastVisitMs = past[0] ? new Date(past[0].start_at).getTime() : null;

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Found customer with ${past.length} past visit(s), ${upcoming.length} upcoming.`,
    success: true,
    data: {
      found: true,
      customer_name: latest.customer_name ?? undefined,
      last_visit:
        lastVisitMs !== null
          ? localIso(lastVisitMs, localOffsetFor(lastVisitMs, shop.timezone))
          : undefined,
      last_visit_label:
        lastVisitMs !== null ? spokenDateTimeLabel(lastVisitMs, shop.timezone) : undefined,
      visit_count: past.length,
      preferred_service: mostCommon(past.map((b) => b.service).filter(Boolean) as string[]),
      preferred_staff: mostCommon(past.map((b) => b.staff)),
      upcoming_bookings: upcoming,
    },
  });
}
