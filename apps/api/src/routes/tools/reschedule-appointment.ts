import type { Context } from 'hono';
import { gcalPatchEvent, getGCalClient } from '../../lib/gcal';
import { sendSms } from '../../lib/sms';
import { getSupabase } from '../../lib/supabase';
import {
  BOOKING_CODE_TTL_MINUTES,
  generateCode,
  storeCode,
  verifyCode,
} from '../../lib/verification';
import type {
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  RescheduleAppointmentParams,
  ShopRow,
  WorkerBindings,
} from '../../types';

export async function handleRescheduleAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    RescheduleAppointmentParams | ElevenLabsToolWebhookRequest<RescheduleAppointmentParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as RescheduleAppointmentParams;
  const { booking_id, code, new_start_time, new_duration_minutes, new_staff_name } = params;

  const db = getSupabase(c.env);
  const { data: booking } = await db
    .from('bookings')
    .select('id, shop_id, customer_phone, staff, start_at, end_at, gcal_event_id, status')
    .eq('id', booking_id)
    .single();

  if (!booking || booking.shop_id !== shop.id) {
    return c.json<ElevenLabsToolWebhookResponse>({ result: 'Booking not found.', success: false });
  }
  if (booking.status === 'cancelled' || booking.status === 'completed') {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'This appointment cannot be rescheduled.',
      success: false,
    });
  }

  const valid = await verifyCode(db, booking_id, code);
  if (!valid) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'Invalid or expired verification code.',
      success: false,
    });
  }

  const staff = new_staff_name ?? booking.staff;
  const durationMs = new_duration_minutes
    ? new_duration_minutes * 60000
    : new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime();
  const newEndAt = new Date(new Date(new_start_time).getTime() + durationMs).toISOString();

  const { error } = await db
    .from('bookings')
    .update({
      start_at: new_start_time,
      end_at: newEndAt,
      staff,
      updated_at: new Date().toISOString(),
    })
    .eq('id', booking_id);

  if (error) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result:
        error.code === '23P01'
          ? `That time with ${staff} is already booked. Please choose a different time.`
          : 'Failed to reschedule. Please try again.',
      success: false,
    });
  }

  if (
    shop.integration === 'google_calendar' &&
    shop.integration_credentials_encrypted &&
    booking.gcal_event_id
  ) {
    const encryptedCreds = shop.integration_credentials_encrypted;
    const eventId = booking.gcal_event_id;
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const gcal = await getGCalClient(c.env, encryptedCreds);
          await gcalPatchEvent(
            gcal.calendar_id,
            gcal.token,
            eventId,
            new_start_time,
            newEndAt,
            shop.timezone,
          );
        } catch {
          // non-fatal
        }
      })(),
    );
  }

  // verifyCode consumed the old single-use code — issue a fresh one so the caller
  // can still cancel or reschedule again.
  const newCode = generateCode();
  await storeCode(db, booking_id, newCode, BOOKING_CODE_TTL_MINUTES);

  const newLabel = new Date(new_start_time).toLocaleString('en-US', {
    timeZone: shop.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const smsSent = await sendSms(
    c.env,
    shop.twilio_number,
    booking.customer_phone,
    `${shop.name}: Your appointment has been rescheduled to ${newLabel} with ${staff}. New verification code: ${newCode}. Keep this to cancel or reschedule.`,
  );

  const result = smsSent
    ? `Appointment rescheduled to ${newLabel} with ${staff}. I've texted your new confirmation code.`
    : `Appointment rescheduled to ${newLabel} with ${staff}. I couldn't send the text — your new code is ${spokenCode(newCode)}. Please write it down.`;

  return c.json<ElevenLabsToolWebhookResponse>({
    result,
    success: true,
    data: {
      rescheduled: true,
      booking_id,
      old_start_time: booking.start_at,
      new_start_time,
      new_end_time: newEndAt,
      staff_name: staff,
      sms_sent: smsSent,
    },
  });
}

function spokenCode(code: string): string {
  return code.split('').join(' ');
}
