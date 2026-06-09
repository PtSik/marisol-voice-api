import type { Context } from 'hono';
import { registerCall } from '../../lib/elevenlabs';
import { toE164 } from '../../lib/normalize';
import { getSupabase } from '../../lib/supabase';
import type { WorkerBindings } from '../../types';
import { buildPersonalizationData } from '../webhooks/personalization';

async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  // Twilio signs: URL + sorted param key+value pairs, HMAC-SHA1, base64
  const sortedKeys = Object.keys(params).sort();
  const message = url + sortedKeys.map((k) => `${k}${params[k] ?? ''}`).join('');

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signature === expected;
}

export async function handleTwilioInbound(
  c: Context<{ Bindings: WorkerBindings }>,
): Promise<Response> {
  const twilioSig = c.req.header('X-Twilio-Signature') ?? '';
  const formData = await c.req.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === 'string') params[key] = value;
  });

  const url = c.req.url;
  const valid = await validateTwilioSignature(c.env.TWILIO_AUTH_TOKEN, url, params, twilioSig);

  if (!valid) {
    return c.text('Forbidden', 403);
  }

  const toNumber = params['To'] ?? '';
  const fromNumber = params['From'] ?? '';

  if (!toNumber || !fromNumber) {
    return c.text('Bad Request', 400);
  }

  let normalizedTo: string;
  try {
    normalizedTo = toE164(toNumber);
  } catch {
    return c.text('Bad Request: invalid To number', 400);
  }

  const db = getSupabase(c.env);
  const { data: shop, error } = await db
    .from('shops')
    .select('*')
    .eq('twilio_number', normalizedTo)
    .single();

  if (error || !shop) {
    return c.text('Not Found: shop not configured for this number', 404);
  }

  const clientData = buildPersonalizationData(shop, fromNumber);

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
