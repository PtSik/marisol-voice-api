import type { Context } from 'hono';
import { tryToE164 } from '../../lib/normalize';
import { sendSms } from '../../lib/sms';
import type { ElevenLabsToolWebhookResponse, EscalateParams, WorkerBindings } from '../../types';
import type { ToolRequest } from './index';

// `req` is not destructured: `db` must stay untouched until the callback branch, so the demo
// and SMS guards above it can be asserted by a client that throws on access.
export async function handleEscalate(
  c: Context<{ Bindings: WorkerBindings }>,
  req: ToolRequest<EscalateParams>,
): Promise<Response> {
  const { params, shop, conversationId } = req;
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

  if (shop.transfers_enabled === false) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result:
        'Live transfers and callback requests are not available for this business right now. I can still help with business questions and appointments.',
      success: true,
      data: { escalated: false, escalation_type, callback_available: false },
    });
  }

  if (escalation_type === 'callback') {
    // During assisted launch there is no callback consumer other than this SMS alert. With SMS
    // disabled, recording a row and promising a callback would silently strand the caller.
    if (c.env.SMS_ENABLED !== 'true' || shop.sms_enabled !== true) {
      return c.json<ElevenLabsToolWebhookResponse>({
        result: `Callback requests aren't available right now. I can transfer you to ${shop.name} instead if you'd like.`,
        success: true,
        data: { escalated: false, escalation_type: 'callback', callback_available: false },
      });
    }

    const db = req.db;
    const normalizedPhone = customer_phone ? (tryToE164(customer_phone) ?? customer_phone) : '';
    const normalizedOwner = tryToE164(shop.owner_escalation_phone);
    if (!normalizedOwner) {
      return c.json<ElevenLabsToolWebhookResponse>({
        result: `I couldn't schedule a callback right now. I can transfer you to ${shop.name} instead if you'd like.`,
        success: true,
        data: { escalated: false, escalation_type: 'callback', callback_available: false },
      });
    }
    const { data: callback, error } = await db
      .from('callbacks')
      .insert({
        shop_id: shop.id,
        customer_phone: normalizedPhone,
        reason: reason ?? null,
        elevenlabs_conversation_id: conversationId.includes('{{') ? null : conversationId || null,
      })
      .select('id')
      .single();
    if (error || !callback) {
      return c.json<ElevenLabsToolWebhookResponse>({
        result: `I couldn't schedule a callback right now. I can transfer you to ${shop.name} instead if you'd like.`,
        success: true,
        data: { escalated: false, escalation_type: 'callback', callback_available: false },
      });
    }

    const notified = await sendSms(
      c.env,
      shop,
      normalizedOwner,
      `${shop.name}: New callback request from ${normalizedPhone || 'unknown number'}. Reason: ${reason ?? 'n/a'}`,
      { requireConsent: false, db },
    );
    if (!notified) {
      // This SMS is the table's only consumer during assisted launch, so a row nobody will read
      // must not outlive the answer the caller just got.
      await db.from('callbacks').delete().eq('id', callback.id);
      return c.json<ElevenLabsToolWebhookResponse>({
        result: `I couldn't schedule a callback right now. I can transfer you to ${shop.name} instead if you'd like.`,
        success: true,
        data: { escalated: false, escalation_type: 'callback', callback_available: false },
      });
    }

    return c.json<ElevenLabsToolWebhookResponse>({
      result: `I've noted your callback request. Someone from ${shop.name} will be in touch shortly.`,
      success: true,
      data: { escalated: true, escalation_type: 'callback' },
    });
  }

  const transferTo = tryToE164(shop.escalation_phone);
  if (!transferTo) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: `I can't complete the transfer right now. Please try calling ${shop.name} directly.`,
      success: true,
      data: { escalated: false, escalation_type: 'transfer' },
    });
  }
  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Transferring you to ${shop.name} now. Please hold.`,
    success: true,
    data: {
      escalated: true,
      escalation_type: 'transfer',
      message: `Transferring you to ${shop.name} now. Please hold.`,
      transfer_to: transferTo,
    },
  });
}
