import { Hono } from 'hono';
import type { Context } from 'hono';
import { tryToE164 } from '../../lib/normalize';
import { getSupabase } from '../../lib/supabase';
import { verifyToolSecret } from '../../middleware/verify-tool-secret';
import type { ShopRow, WorkerBindings } from '../../types';
import { handleBookAppointment } from './book-appointment';
import { handleCancelAppointment } from './cancel-appointment';
import { handleCheckAvailability } from './check-availability';
import { handleEscalate } from './escalate';
import { handleLookupCustomer } from './lookup-customer';
import { handleRescheduleAppointment } from './reschedule-appointment';

export const toolRoutes = new Hono<{ Bindings: WorkerBindings }>();

toolRoutes.use('*', verifyToolSecret());

const cleanVar = (v: string | undefined): string => (v && !v.includes('{{') ? v.trim() : '');

interface ToolIdentifiers {
  shopId: string;
  calledNumber: string;
  conversationId: string;
}

// ElevenLabs substitutes dynamic variables in the tool BODY (not headers), and may send
// the LLM params either flat or nested under `parameters`. Read identifiers from both.
export async function readIdentifiers(
  c: Context<{ Bindings: WorkerBindings }>,
): Promise<ToolIdentifiers> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await c.req.json<Record<string, unknown>>();
  } catch {}
  const nested = (raw.parameters as Record<string, unknown> | undefined) ?? {};
  const pick = (key: string) => cleanVar((raw[key] ?? nested[key]) as string | undefined);
  return {
    shopId: pick('shop_id'),
    calledNumber: pick('called_number'),
    conversationId: pick('conversation_id'),
  };
}

export async function resolveShopFrom(
  db: ReturnType<typeof getSupabase>,
  ids: ToolIdentifiers,
): Promise<ShopRow | null> {
  // 1. Deterministic: the shop_id dynamic variable injected at call start → primary key.
  if (ids.shopId) {
    const { data: shop } = await db.from('shops').select('*').eq('id', ids.shopId).single();
    if (shop) return shop as ShopRow;
  }

  // 2. Deterministic: the dialed number → unique twilio_number. Always present on Twilio
  //    and immune to the async calls-row insert, so it works even on the first tool call.
  if (ids.calledNumber) {
    const normalized = tryToE164(ids.calledNumber);
    if (normalized) {
      const { data: shop } = await db
        .from('shops')
        .select('*')
        .eq('twilio_number', normalized)
        .single();
      if (shop) return shop as ShopRow;
    }
  }

  // 3. conversation_id → calls join (works once the calls row has been written).
  if (ids.conversationId) {
    const { data } = await db
      .from('calls')
      .select('shops(*)')
      .eq('elevenlabs_conversation_id', ids.conversationId)
      .single();
    const shop = (data as unknown as { shops: ShopRow | null } | null)?.shops ?? null;
    if (shop) return shop;
  }

  return null;
}

async function resolveShop(c: Context<{ Bindings: WorkerBindings }>): Promise<ShopRow | null> {
  const ids = await readIdentifiers(c);
  return resolveShopFrom(getSupabase(c.env), ids);
}

type ToolHandler = (c: Context<{ Bindings: WorkerBindings }>, shop: ShopRow) => Promise<Response>;

function toolRoute(handler: ToolHandler) {
  return async (c: Context<{ Bindings: WorkerBindings }>) => {
    const shop = await resolveShop(c);
    if (!shop)
      return c.json(
        { result: 'Unknown conversation or shop not configured.', success: false },
        404,
      );
    return handler(c, shop);
  };
}

toolRoutes.post('/check_availability', toolRoute(handleCheckAvailability));
toolRoutes.post('/book_appointment', toolRoute(handleBookAppointment));
toolRoutes.post('/lookup_customer', toolRoute(handleLookupCustomer));
toolRoutes.post('/cancel_appointment', toolRoute(handleCancelAppointment));
toolRoutes.post('/reschedule_appointment', toolRoute(handleRescheduleAppointment));
toolRoutes.post('/escalate', toolRoute(handleEscalate));
