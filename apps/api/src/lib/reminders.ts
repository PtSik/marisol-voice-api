import type { WorkerBindings } from '../types';
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
  staff: string;
  service: string | null;
  start_at: string;
  language: string;
  shops: {
    name: string;
    timezone: string;
    twilio_number: string;
    reminders_enabled: boolean;
  } | null;
}

export function composeReminder(booking: DueBooking): string | null {
  const shop = booking.shops;
  if (!shop?.reminders_enabled) return null;
  const lang = normalizeSmsLanguage(booking.language);
  const whenLabel = smsWhenLabel(new Date(booking.start_at).getTime(), shop.timezone, lang);
  return reminderSms(lang, { shopName: shop.name, whenLabel, staff: booking.staff });
}

export async function runReminders(
  env: WorkerBindings,
  nowMs = Date.now(),
): Promise<{ sent: number; skipped: number }> {
  const db = getSupabase(env);
  const { from, to } = reminderWindow(nowMs);
  const { data, error } = await db
    .from('bookings')
    .select(
      'id, customer_phone, staff, service, start_at, language, shops(name, timezone, twilio_number, reminders_enabled)',
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
    const ok = await sendSms(env, booking.shops.twilio_number, booking.customer_phone, body);
    if (ok) {
      sent++;
    } else {
      console.log('[reminders] send failed for booking', booking.id);
      skipped++;
    }
  }
  return { sent, skipped };
}
