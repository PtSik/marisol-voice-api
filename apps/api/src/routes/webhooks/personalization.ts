import type { Context } from 'hono';
import { getHoursForDate, isClosed } from '../../lib/hours';
import { toE164, tryToE164 } from '../../lib/normalize';
import { getSupabase } from '../../lib/supabase';
import type {
  ConversationDynamicVariables,
  ConversationInitiationClientData,
  ShopRow,
  WorkerBindings,
} from '../../types';

export function buildPersonalizationData(
  shop: ShopRow,
  callerPhone: string,
): ConversationInitiationClientData {
  const now = new Date();
  const dynamicVars: ConversationDynamicVariables = {
    shop_id: shop.id,
    shop_name: shop.name,
    hours_summary: formatSchedule(shop, now),
    services_summary: formatJson(shop.services_json),
    staff_summary: formatJson(shop.staff_json),
    escalation_phone: shop.escalation_phone,
    ai_disclosure_text: shop.ai_disclosure_text,
    caller_phone: callerPhone,
    shop_timezone: shop.timezone,
    // Pre-computed in the shop's timezone so the agent never has to convert UTC → local
    // (which broke after-hours date math). Computed per call; the date doesn't drift.
    shop_local_date: now.toLocaleDateString('en-CA', { timeZone: shop.timezone }),
    shop_local_datetime: now.toLocaleString('en-US', {
      timeZone: shop.timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
  };

  return { dynamic_variables: dynamicVars };
}

// Hours are pre-resolved per calendar date here so the agent never has to derive a
// weekday or map it to an hours line itself — that date math is what produced wrong
// spoken hours. Each line carries the weekday and the YYYY-MM-DD the agent passes to tools.
const SCHEDULE_DAYS = 7;

function clockLabel(minutesFromMidnight: number): string {
  let hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  const period = hour >= 12 ? 'pm' : 'am';
  hour %= 12;
  if (hour === 0) hour = 12;
  return minute === 0 ? `${hour}${period}` : `${hour}:${String(minute).padStart(2, '0')}${period}`;
}

function formatSchedule(shop: ShopRow, now: Date): string {
  const todayLocal = now.toLocaleDateString('en-CA', { timeZone: shop.timezone });
  const base = new Date(`${todayLocal}T12:00:00Z`).getTime();
  const lines: string[] = [];

  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const day = new Date(base + i * 86_400_000);
    const dateStr = day.toISOString().slice(0, 10);
    const weekday = day.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const monthDay = day.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

    let hrs: string;
    if (isClosed(shop.closures_json, dateStr)) {
      hrs = 'closed';
    } else {
      const open = getHoursForDate(shop.hours_json, dateStr);
      hrs = open ? `${clockLabel(open.open)}–${clockLabel(open.close)}` : 'closed';
    }

    const prefix = i === 0 ? 'Today — ' : i === 1 ? 'Tomorrow — ' : '';
    lines.push(`${prefix}${weekday}, ${monthDay} (${dateStr}): ${hrs}`);
  }

  return lines.join('\n');
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

  const normalizedTo: string | null = tryToE164(calledNumber);
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
