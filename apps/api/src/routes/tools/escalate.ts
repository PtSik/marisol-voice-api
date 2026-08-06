import type { Context } from 'hono';
import { tryToE164 } from '../../lib/normalize';
import { sendSms } from '../../lib/sms';
import { getSupabase } from '../../lib/supabase';
import type {
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  EscalateParams,
  ShopRow,
  WorkerBindings,
} from '../../types';

export async function handleEscalate(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<EscalateParams | ElevenLabsToolWebhookRequest<EscalateParams>>();
  const params = ('parameters' in raw ? raw.parameters : raw) as EscalateParams;
  const conversationId =
    c.req.header('X-Conversation-Id') ??
    ('conversation_id' in raw ? raw.conversation_id : '') ??
    '';
  const { reason, escalation_type, customer_phone } = params;

  // A demo has nobody behind it. Transferring hands the caller `escalation_phone` — ours, on a pool
  // number renamed to answer as their own salon — and a callback texts us to ring a prospect who was
  // only testing the agent. The DEMO agents are also configured without this tool and told so by the
  // prompt overlay, but both of those are dashboard state that a stray click can undo; this is the
  // copy that ships with the worker.
  //
  // Returning success with a spoken line rather than an error on purpose: `success: false` makes the
  // agent read a failure out loud ("that didn't work"), which is a worse demo than an honest answer.
  if (shop.is_demo) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result:
        "This is a demo line, so there's no one to put you through to — but I can still book, move or cancel an appointment for you right now.",
      success: true,
      data: { escalated: false, escalation_type, demo: true },
    });
  }

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

    c.executionCtx.waitUntil(
      sendSms(
        c.env,
        shop.twilio_number,
        shop.owner_escalation_phone,
        `${shop.name}: New callback request from ${normalizedPhone || 'unknown number'}. Reason: ${reason ?? 'n/a'}`,
      ),
    );

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
