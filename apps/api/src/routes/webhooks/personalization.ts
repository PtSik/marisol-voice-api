import type { Context } from 'hono';
import type { WorkerBindings, ShopRow, ConversationInitiationClientData, ConversationDynamicVariables } from '../../types';
import { getSupabase } from '../../lib/supabase';
import { toE164, tryToE164 } from '../../lib/normalize';

export function buildPersonalizationData(
  shop: ShopRow,
  callerPhone: string,
): ConversationInitiationClientData {
  const dynamicVars: ConversationDynamicVariables = {
    shop_name: shop.name,
    hours_summary: formatHours(shop.hours_json),
    services_summary: formatJson(shop.services_json),
    staff_summary: formatJson(shop.staff_json),
    escalation_phone: shop.escalation_phone,
    ai_disclosure_text: shop.ai_disclosure_text,
    caller_phone: callerPhone,
    shop_timezone: shop.timezone,
  };

  return { dynamic_variables: dynamicVars };
}

function formatHours(hoursJson: string): string {
  try {
    const parsed = JSON.parse(hoursJson);
    if (typeof parsed === 'string') return parsed;
    // Accept { "Mon-Sat": "9am-7pm", "Sun": "10am-5pm" } or array
    if (Array.isArray(parsed)) return parsed.join(', ');
    return Object.entries(parsed)
      .map(([day, hrs]) => `${day} ${hrs}`)
      .join(', ');
  } catch {
    return hoursJson;
  }
}

function formatJson(json: string): string {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.join(', ');
    return String(parsed);
  } catch {
    return json;
  }
}

export async function handlePersonalization(
  c: Context<{ Bindings: WorkerBindings }>,
): Promise<Response> {
  let body: { caller_id?: string; called_number?: string; call_sid?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const calledNumber = body.called_number ?? '';
  const callerPhone = body.caller_id ?? '';

  let normalizedTo: string | null = tryToE164(calledNumber);
  if (!normalizedTo) {
    return c.json({ error: 'Invalid called_number' }, 400);
  }

  const db = getSupabase(c.env);
  const { data: shop, error } = await db
    .from('shops')
    .select('*')
    .eq('twilio_number', normalizedTo)
    .single();

  if (error || !shop) {
    return c.json({ error: 'Shop not found for this number' }, 404);
  }

  const responseData = buildPersonalizationData(shop, callerPhone);
  return c.json(responseData);
}
