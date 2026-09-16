import type { Context } from 'hono';
import { tryToE164 } from '../../lib/normalize';
import { getSupabase } from '../../lib/supabase';
import { readSignedTwilioForm } from '../../lib/twilio-signature';
import type { WorkerBindings } from '../../types';

export type SmsPreferenceAction = 'opted_in' | 'opted_out' | 'help' | null;

const STOP_WORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
]);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

export function smsPreferenceAction(body: string, optOutType?: string): SmsPreferenceAction {
  const keyword = (optOutType || body).trim().toUpperCase();
  if (keyword === 'STOP' || STOP_WORDS.has(keyword)) return 'opted_out';
  if (keyword === 'START' || START_WORDS.has(keyword)) return 'opted_in';
  if (keyword === 'HELP' || HELP_WORDS.has(keyword)) return 'help';
  return null;
}

export async function handleTwilioSms(c: Context<{ Bindings: WorkerBindings }>): Promise<Response> {
  const params = await readSignedTwilioForm(c.req.raw, c.env.TWILIO_AUTH_TOKEN);
  if (!params) return c.text('Forbidden', 403);

  const from = tryToE164(params.From ?? '');
  const to = tryToE164(params.To ?? '');
  if (!from || !to) return c.text('Bad Request', 400);

  const action = smsPreferenceAction(params.Body ?? '', params.OptOutType);
  if (action === 'opted_in' || action === 'opted_out') {
    const db = getSupabase(c.env);
    const { error } = await db.from('sms_preferences').upsert(
      {
        sender_phone: to,
        phone: from,
        status: action,
        source: params.OptOutType ? 'twilio_advanced_opt_out' : 'keyword',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'sender_phone,phone' },
    );
    if (error) return c.text('Preference unavailable', 503);
  }

  // Twilio handles the standard STOP/START/HELP reply. Returning empty TwiML avoids a duplicate.
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'application/xml' },
  });
}
