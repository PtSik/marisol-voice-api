import { Hono } from 'hono';
import type { Context } from 'hono';
import type { WorkerBindings, ShopRow } from '../../types';
import { getSupabase } from '../../lib/supabase';
import { handleCheckAvailability } from './check-availability';
import { handleBookAppointment } from './book-appointment';
import { handleLookupCustomer } from './lookup-customer';
import { handleCancelAppointment } from './cancel-appointment';
import { handleRescheduleAppointment } from './reschedule-appointment';
import { handleEscalate } from './escalate';

export const toolRoutes = new Hono<{ Bindings: WorkerBindings }>();

async function resolveShop(c: Context<{ Bindings: WorkerBindings }>): Promise<ShopRow | null> {
  // ElevenLabs header substitution is unreliable — try header, then body, then fall back
  // to the most recent active call. Single-shop MVP can tolerate the fallback since calls
  // are short-lived; multi-tenant will need a proper conversation_id pipeline.
  let conversationId = c.req.header('X-Conversation-Id') ?? '';
  if (conversationId.includes('{{')) conversationId = '';

  if (!conversationId) {
    try {
      const body = await c.req.json<{ conversation_id?: string }>();
      if (body.conversation_id && !body.conversation_id.includes('{{')) {
        conversationId = body.conversation_id;
      }
    } catch {}
  }

  const db = getSupabase(c.env);

  if (conversationId) {
    const { data: call } = await db
      .from('calls')
      .select('shop_id')
      .eq('elevenlabs_conversation_id', conversationId)
      .single();
    if (call) {
      const { data: shop } = await db.from('shops').select('*').eq('id', call.shop_id).single();
      return shop ?? null;
    }
  }

  // Fallback: most recent call in the last 10 minutes
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: recent } = await db
    .from('calls')
    .select('shop_id')
    .gte('started_at', tenMinAgo)
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (!recent) {
    console.log('[resolveShop] no recent call within 10min');
    return null;
  }

  const { data: shop } = await db.from('shops').select('*').eq('id', recent.shop_id).single();
  return shop ?? null;
}

type ToolHandler = (c: Context<{ Bindings: WorkerBindings }>, shop: ShopRow) => Promise<Response>;

function toolRoute(handler: ToolHandler) {
  return async (c: Context<{ Bindings: WorkerBindings }>) => {
    const shop = await resolveShop(c);
    if (!shop) return c.json({ result: 'Unknown conversation or shop not configured.', success: false }, 404);
    return handler(c, shop);
  };
}

toolRoutes.post('/check_availability', toolRoute(handleCheckAvailability));
toolRoutes.post('/book_appointment', toolRoute(handleBookAppointment));
toolRoutes.post('/lookup_customer', toolRoute(handleLookupCustomer));
toolRoutes.post('/cancel_appointment', toolRoute(handleCancelAppointment));
toolRoutes.post('/reschedule_appointment', toolRoute(handleRescheduleAppointment));
toolRoutes.post('/escalate', toolRoute(handleEscalate));
