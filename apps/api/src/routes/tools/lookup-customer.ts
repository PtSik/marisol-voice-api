import type { Context } from 'hono';
import type {
  WorkerBindings,
  ShopRow,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  LookupCustomerParams,
} from '../../types';
import { getSupabase } from '../../lib/supabase';
import { tryToE164 } from '../../lib/normalize';

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
  const raw = await c.req.json<LookupCustomerParams | ElevenLabsToolWebhookRequest<LookupCustomerParams>>();
  const params = ('parameters' in raw ? raw.parameters : raw) as LookupCustomerParams;
  const { phone_number } = params;

  const normalized = tryToE164(phone_number);
  if (!normalized) {
    return c.json<ElevenLabsToolWebhookResponse>({ result: 'Invalid phone number.', success: false });
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

  const completed = bookings.filter((b) => b.status === 'completed' || b.status === 'confirmed');
  const latest = bookings[0];
  if (!latest) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'No customer record found for that phone number.',
      success: true,
      data: { found: false },
    });
  }

  const nowIso = new Date().toISOString();
  const upcoming = bookings
    .filter((b) => b.status === 'confirmed' && b.start_at > nowIso)
    .map((b) => ({
      booking_id: b.id,
      start_at: b.start_at,
      end_at: b.end_at,
      service: b.service,
      staff: b.staff,
    }));

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Found customer with ${bookings.length} booking(s), ${upcoming.length} upcoming.`,
    success: true,
    data: {
      found: true,
      customer_name: latest.customer_name ?? undefined,
      last_visit: latest.start_at,
      visit_count: completed.length,
      preferred_service: mostCommon(completed.map((b) => b.service).filter(Boolean) as string[]),
      preferred_staff: mostCommon(completed.map((b) => b.staff)),
      upcoming_bookings: upcoming,
    },
  });
}
