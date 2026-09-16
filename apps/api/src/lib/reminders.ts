import type { WorkerBindings } from '../types';
import { canServeCalls } from './shop-status';
import { sendSms } from './sms';
import { normalizeSmsLanguage, reminderSms, smsWhenLabel } from './sms-templates';
import { getSupabase } from './supabase';

// Bookings created less than 23h before start get no reminder (they just got the
// confirmation text); the 2h-wide window plus the reminder_sent_at claim makes
// overlapping or delayed cron ticks safe.
const WINDOW_START_HOURS = 23;
const WINDOW_END_HOURS = 25;

export function reminderWindow(nowMs: number): { from: string; to: string } {
  return {
    from: new Date(nowMs + WINDOW_START_HOURS * 3_600_000).toISOString(),
    to: new Date(nowMs + WINDOW_END_HOURS * 3_600_000).toISOString(),
  };
}

export interface DueBooking {
  id: string;
  customer_phone: string;
  sms_consent_at: string | null;
  staff: string;
  service: string | null;
  start_at: string;
  language: string;
  shops: {
    id: string;
    name: string;
    timezone: string;
    twilio_number: string;
    reminders_enabled: boolean;
    sms_enabled: boolean;
    status: string;
  } | null;
}

export function composeReminder(booking: DueBooking): string | null {
  const shop = booking.shops;
  if (
    !shop?.reminders_enabled ||
    !shop.sms_enabled ||
    !booking.sms_consent_at ||
    !canServeCalls(shop.status)
  )
    return null;
  const lang = normalizeSmsLanguage(booking.language);
  const whenLabel = smsWhenLabel(new Date(booking.start_at).getTime(), shop.timezone, lang);
  return reminderSms(lang, { shopName: shop.name, whenLabel, staff: booking.staff });
}

export async function runReminders(
  env: WorkerBindings,
  nowMs = Date.now(),
): Promise<{ sent: number; skipped: number }> {
  // Do not even claim rows while the launch-wide SMS switch is off. Claims happen before sends to
  // prevent duplicates, so entering the loop would otherwise permanently mark an unsent reminder.
  if (env.SMS_ENABLED !== 'true') {
    console.log('[reminders] skipped: SMS_ENABLED is not true');
    return { sent: 0, skipped: 0 };
  }
  const db = getSupabase(env);
  const { from, to } = reminderWindow(nowMs);
  const { data, error } = await db
    .from('bookings')
    .select(
      'id, customer_phone, staff, service, start_at, language, sms_consent_at, shops(id, name, timezone, twilio_number, reminders_enabled, sms_enabled, status)',
    )
    .eq('status', 'confirmed')
    .is('reminder_sent_at', null)
    .gte('start_at', from)
    .lte('start_at', to);

  if (error || !data) {
    console.log('[reminders] select error:', error?.message);
    return { sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;
  for (const booking of data as unknown as DueBooking[]) {
    const body = composeReminder(booking);
    if (!body || !booking.shops) {
      skipped++;
      continue;
    }
    // Claim before sending — on racing ticks a lost SMS beats a double one.
    const { data: claimed } = await db
      .from('bookings')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', booking.id)
      .is('reminder_sent_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }
    const ok = await sendSms(env, booking.shops, booking.customer_phone, body, {
      consentAt: booking.sms_consent_at,
    });
    if (ok) {
      sent++;
    } else {
      console.log('[reminders] send failed for booking', booking.id);
      skipped++;
    }
  }
  return { sent, skipped };
}
