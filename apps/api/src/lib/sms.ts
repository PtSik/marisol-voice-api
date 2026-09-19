import type { ShopRow, WorkerBindings } from '../types';
import { getSupabase } from './supabase';

// A tool webhook awaits this on a live call, so a hung Twilio request is dead air the caller
// hears — and long enough to trip the ElevenLabs tool timeout.
const SMS_TIMEOUT_MS = 5_000;

type SmsShop = Pick<ShopRow, 'twilio_number' | 'sms_enabled'>;

export interface SmsOptions {
  // Customer messages require explicit consent captured during booking. Operational messages to
  // the subscribed business owner can opt out through the same recipient preference table.
  consentAt?: string | null;
  requireConsent?: boolean;
}

export async function sendSms(
  env: WorkerBindings,
  shop: SmsShop,
  to: string,
  body: string,
  options: SmsOptions = {},
): Promise<boolean> {
  if (env.SMS_ENABLED !== 'true') {
    console.log('[sms] blocked: SMS_ENABLED is not true');
    return false;
  }
  if (shop.sms_enabled !== true) {
    console.log('[sms] blocked: shop is not approved for SMS');
    return false;
  }
  if (options.requireConsent !== false && !options.consentAt) {
    console.log('[sms] blocked: recipient consent is missing');
    return false;
  }

  const from = env.TWILIO_SMS_FROM || shop.twilio_number;
  const db = getSupabase(env);
  const { data: preference, error } = await db
    .from('sms_preferences')
    .select('status')
    .eq('sender_phone', from)
    .eq('phone', to)
    .maybeSingle();
  // Preference storage is part of the safety boundary. If it cannot be checked, fail closed.
  if (error) {
    console.log('[sms] blocked: recipient preference unavailable');
    return false;
  }
  if (preference?.status === 'opted_out') {
    console.log('[sms] blocked: recipient opted out');
    return false;
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
