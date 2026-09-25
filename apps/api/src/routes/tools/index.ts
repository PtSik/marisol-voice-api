import { Hono } from 'hono';
import type { Context } from 'hono';
import { tryToE164 } from '../../lib/normalize';
import { canServeCalls } from '../../lib/shop-status';
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

toolRoutes.use('*', verifyToolSecret);

const cleanVar = (v: string | undefined): string => (v && !v.includes('{{') ? v.trim() : '');

interface ToolIdentifiers {
  shopId: string;
  calledNumber: string;
  conversationId: string;
}

// A malformed body is not an error here: it resolves no shop, and the wrapper answers 404 in
// tool shape rather than letting a parse throw reach the caller as dead air.
export async function readToolBody(
  c: Context<{ Bindings: WorkerBindings }>,
): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return {};
  }
}

// ElevenLabs substitutes dynamic variables in the tool BODY (not headers), and may send
// the LLM params either flat or nested under `parameters`. Read identifiers from both.
export function readIdentifiers(raw: Record<string, unknown>): ToolIdentifiers {
  const nested = (raw.parameters as Record<string, unknown> | undefined) ?? {};
  const pick = (key: string) => cleanVar((raw[key] ?? nested[key]) as string | undefined);
  return {
    shopId: pick('shop_id'),
    calledNumber: pick('called_number'),
    conversationId: pick('conversation_id'),
  };
}

export function hasPhoneContext(raw: unknown): boolean {
  const body = (raw ?? {}) as Record<string, unknown>;
  const nested = (body.parameters as Record<string, unknown> | undefined) ?? {};
  return !!cleanVar((body.called_number ?? nested.called_number) as string | undefined);
}

export async function resolveShopFrom(
  db: ReturnType<typeof getSupabase>,
  ids: ToolIdentifiers,
): Promise<ShopRow | null> {
  // 1. Deterministic: the shop_id dynamic variable injected at call start → primary key.
  if (ids.shopId) {
    const { data: shop } = await db.from('shops').select('*').eq('id', ids.shopId).single();
    // Answering "not serving" rather than falling through: a recycled twilio_number would
    // otherwise resolve this call to whichever active shop holds that number now.
    if (shop) return canServeCalls(shop.status) ? (shop as ShopRow) : null;
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
      if (shop) return canServeCalls(shop.status) ? (shop as ShopRow) : null;
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
    if (shop) return canServeCalls(shop.status) ? shop : null;
  }

  return null;
}

// One parse, one Supabase client and one shop lookup per tool request. Handlers take this
// instead of re-reading the body: Hono re-runs JSON.parse on every `c.req.json()`.
export interface ToolRequest<P> {
  // The body as received. `hasPhone` and `conversationId` are the only things read from it
  // today, but unwrapping `parameters` loses fields a supported request puts outside them.
  raw: Record<string, unknown>;
  params: P;
  shop: ShopRow;
  db: ReturnType<typeof getSupabase>;
  // A browser demo has no caller ID. Anything that writes or texts is gated on this.
  hasPhone: boolean;
  // Header first, then the outer body field — the nested copy is not a fallback here.
  // Unsubstituted placeholders are cleaned at each write site, not here.
  conversationId: string;
}

type ToolHandler<P> = (
  c: Context<{ Bindings: WorkerBindings }>,
  req: ToolRequest<P>,
) => Promise<Response>;

function toolRoute<P>(handler: ToolHandler<P>) {
  return async (c: Context<{ Bindings: WorkerBindings }>) => {
    const raw = await readToolBody(c);
    const db = getSupabase(c.env);
    const shop = await resolveShopFrom(db, readIdentifiers(raw));
    if (!shop)
      return c.json(
        { result: 'Unknown conversation or shop not configured.', success: false },
        404,
      );
    return handler(c, {
      raw,
      params: ('parameters' in raw ? raw.parameters : raw) as P,
      shop,
      db,
      hasPhone: hasPhoneContext(raw),
      conversationId:
        c.req.header('X-Conversation-Id') ??
        (('conversation_id' in raw ? raw.conversation_id : '') as string) ??
        '',
    });
  };
}

toolRoutes.post('/check_availability', toolRoute(handleCheckAvailability));
toolRoutes.post('/book_appointment', toolRoute(handleBookAppointment));
toolRoutes.post('/lookup_customer', toolRoute(handleLookupCustomer));
toolRoutes.post('/cancel_appointment', toolRoute(handleCancelAppointment));
toolRoutes.post('/reschedule_appointment', toolRoute(handleRescheduleAppointment));
toolRoutes.post('/escalate', toolRoute(handleEscalate));
