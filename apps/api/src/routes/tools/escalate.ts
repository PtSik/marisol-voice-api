import type { Context } from 'hono';
import type {
  WorkerBindings,
  ShopRow,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  EscalateParams,
} from '../../types';
import { getSupabase } from '../../lib/supabase';
import { tryToE164 } from '../../lib/normalize';

export async function handleEscalate(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<EscalateParams | ElevenLabsToolWebhookRequest<EscalateParams>>();
  const params = ('parameters' in raw ? raw.parameters : raw) as EscalateParams;
  const conversationId = c.req.header('X-Conversation-Id') ?? ('conversation_id' in raw ? raw.conversation_id : '') ?? '';
  const { reason, escalation_type, customer_phone } = params;

  if (escalation_type === 'callback') {
    const db = getSupabase(c.env);
    const normalizedPhone = customer_phone ? (tryToE164(customer_phone) ?? customer_phone) : '';
    await db.from('callbacks').insert({
      shop_id: shop.id,
      customer_phone: normalizedPhone,
      reason: reason ?? null,
      elevenlabs_conversation_id: conversationId.includes('{{') ? null : conversationId || null,
      status: 'pending',
    });

    return c.json<ElevenLabsToolWebhookResponse>({
      result: `I've noted your callback request. Someone from ${shop.name} will be in touch shortly.`,
      success: true,
      data: { escalated: true, escalation_type: 'callback' },
    });
  }

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Transferring you to ${shop.name} now. Please hold.`,
    success: true,
    data: {
      escalated: true,
      escalation_type: 'transfer',
      message: `Transferring you to ${shop.name} now. Please hold.`,
      transfer_to: shop.escalation_phone,
    },
  });
}
