import { Hono } from 'hono';
import type { Context } from 'hono';
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

async function resolveShop(c: Context<{ Bindings: WorkerBindings }>): Promise<ShopRow | null> {
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

  // Happy path: a single round-trip — embed the shop row alongside the call lookup.
  if (conversationId) {
    const { data } = await db
      .from('calls')
      .select('shops(*)')
      .eq('elevenlabs_conversation_id', conversationId)
      .single();
    const shop = (data as unknown as { shops: ShopRow | null } | null)?.shops ?? null;
    if (shop) return shop;
  }

  // Fallback — conversation_id is unreliable on ElevenLabs tool calls. Use the most
  // recent call only when it is unambiguous; refuse if more than one shop was active in
  // the window, since guessing across tenants could leak or mis-route data.
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: recent } = await db
    .from('calls')
    .select('shop_id')
    .gte('started_at', tenMinAgo)
    .order('started_at', { ascending: false })
    .limit(10);

  const shopIds = [...new Set((recent ?? []).map((r) => r.shop_id))];
  if (shopIds.length !== 1) {
    console.warn(`[resolveShop] no unambiguous shop (candidates: ${shopIds.length})`);
    return null;
  }

  const { data: shop } = await db.from('shops').select('*').eq('id', shopIds[0]).single();
  return shop ?? null;
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
