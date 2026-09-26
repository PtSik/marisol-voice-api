import type { Context } from 'hono';
import { registerCall } from '../../lib/elevenlabs';
import { tryToE164 } from '../../lib/normalize';
import { canServeCalls } from '../../lib/shop-status';
import { getSupabase } from '../../lib/supabase';
import { readSignedTwilioForm } from '../../lib/twilio-signature';
import type { WorkerBindings } from '../../types';
import { buildPersonalizationData } from '../webhooks/personalization';

// Everything the caller hears when the line cannot be served. A sentence, because Twilio answers a
// bare error with its own application-error tone and the caller learns nothing from it.
const OUT_OF_SERVICE_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not in service at the moment. Please try again later.</Say><Hangup/></Response>';

export async function handleTwilioInbound(
  c: Context<{ Bindings: WorkerBindings }>,
): Promise<Response> {
  const params = await readSignedTwilioForm(c.req.raw, c.env.TWILIO_AUTH_TOKEN);
  if (!params) {
    return c.text('Forbidden', 403);
  }

  const toNumber = params.To ?? '';
  const fromNumber = params.From ?? '';

  if (!toNumber || !fromNumber) {
    return c.text('Bad Request', 400);
  }

  const normalizedTo = tryToE164(toNumber);
  if (!normalizedTo) return c.text('Bad Request: invalid To number', 400);

  const db = getSupabase(c.env);
  const { data: shop, error } = await db
    .from('shops')
    .select('*')
    .eq('twilio_number', normalizedTo)
    .single();

  if (error || !shop) {
    return c.text('Not Found: shop not configured for this number', 404);
  }

  // Filtering status in the query would make this indistinguishable from an unknown number, and
  // Twilio answers a 404 with its own application-error tone — nothing the caller can act on and
  // nothing in the logs to say which line it was.
  if (!canServeCalls(shop.status)) {
    console.log(`[twilio-inbound] ${normalizedTo} not served: status ${shop.status}`);
    return new Response(OUT_OF_SERVICE_TWIML, { headers: { 'Content-Type': 'application/xml' } });
  }

  // No agent is a provisioning fault, not a licence to answer with a default one. A single template
  // agent used to cover this, which meant a shop created without its own answered in whichever
  // vertical the secret happened to point at — the right words in the wrong trade, and nothing
  // anywhere saying so. Refusing is the honest failure, and it is loud in the logs.
  if (!shop.elevenlabs_agent_id) {
    console.error(`[twilio-inbound] ${normalizedTo} has no elevenlabs_agent_id — refusing`);
    return new Response(OUT_OF_SERVICE_TWIML, { headers: { 'Content-Type': 'application/xml' } });
  }

  const clientData = buildPersonalizationData(shop, fromNumber, c.env.SMS_ENABLED === 'true');

  const result = await registerCall(
    c.env,
    fromNumber,
    normalizedTo,
    clientData,
    shop.elevenlabs_agent_id,
  );

  // Inject dynamic_variables as Stream Parameters since register-call ignores
  // conversation_initiation_client_data on the request body.
  const extraParams = Object.entries(clientData.dynamic_variables ?? {})
    .map(([k, v]) => `<Parameter name="${escapeXmlAttr(k)}" value="${escapeXmlAttr(String(v))}"/>`)
    .join('');
  const twiml = result.twiml.replace('</Stream>', `${extraParams}</Stream>`);

  c.executionCtx.waitUntil(
    Promise.resolve(
      db.from('calls').insert({
        shop_id: shop.id,
        elevenlabs_conversation_id: result.conversation_id,
        started_at: new Date().toISOString(),
      }),
    ),
  );

  return new Response(twiml, {
    headers: { 'Content-Type': 'application/xml' },
  });
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
