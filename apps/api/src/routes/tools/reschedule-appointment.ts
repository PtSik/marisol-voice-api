import type { Context } from 'hono';
import { gcalPatchEvent, getGCalClient } from '../../lib/gcal';
import { type BookingTimeReason, spokenDateTimeLabel, validateBookingTime } from '../../lib/hours';
import { sendSms } from '../../lib/sms';
import {
  normalizeSmsLanguage,
  rescheduleConfirmationSms,
  smsWhenLabel,
} from '../../lib/sms-templates';
import { findStaff } from '../../lib/staff';
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
import { hasPhoneContext } from './index';

export async function handleRescheduleAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    RescheduleAppointmentParams | ElevenLabsToolWebhookRequest<RescheduleAppointmentParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as RescheduleAppointmentParams;
  const { booking_id, code, new_start_time, new_duration_minutes, new_staff_name } = params;

  if (!hasPhoneContext(raw)) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: "You're all set — in the real product I'd text your confirmation now.",
      success: true,
    });
  }

  const db = getSupabase(c.env);
  const { data: booking } = await db
    .from('bookings')
    .select('id, shop_id, customer_phone, staff, start_at, end_at, gcal_event_id, status, language')
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

  // Validate the new time before consuming the single-use code, so a bad time doesn't
  // burn the caller's code.
  const durationMinutes =
    new_duration_minutes ??
    Math.round((new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime()) / 60000);

  const staff = new_staff_name ?? booking.staff;
  const validation = validateBookingTime(
    shop,
    new_start_time,
    durationMinutes,
    findStaff(shop.staff_json, staff),
  );
  if (!validation.ok) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: rescheduleTimeError(validation.reason, staff),
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

  const language = normalizeSmsLanguage(params.language ?? booking.language);
  const newEndAt = new Date(
    new Date(new_start_time).getTime() + durationMinutes * 60000,
  ).toISOString();

  const { error } = await db
    .from('bookings')
    .update({
      start_at: new_start_time,
      end_at: newEndAt,
      staff,
      language,
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

  const smsLabel = smsWhenLabel(new Date(new_start_time).getTime(), shop.timezone, language);
  const spokenLabel = spokenDateTimeLabel(new Date(new_start_time).getTime(), shop.timezone);
  const smsSent = await sendSms(
    c.env,
    shop.twilio_number,
    booking.customer_phone,
    rescheduleConfirmationSms(language, {
      shopName: shop.name,
      whenLabel: smsLabel,
      staff,
      code: newCode,
    }),
  );

  const result = smsSent
    ? `Appointment rescheduled to ${spokenLabel} with ${staff}. I've texted your new confirmation code.`
    : `Appointment rescheduled to ${spokenLabel} with ${staff}. I couldn't send the text — your new code is ${spokenCode(newCode)}. Please write it down.`;

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

function rescheduleTimeError(reason: BookingTimeReason, staffName: string): string {
  switch (reason) {
    case 'past':
      return 'That new time has already passed. Please pick a later time.';
    case 'closed':
      return "We're closed that day. Could we pick another day?";
    case 'outside_hours':
      return "That's outside our opening hours. Let's pick a time while we're open.";
    case 'staff_away':
      return `${staffName} isn't working then. I can look at another time or someone else.`;
    default:
      return "That doesn't look like a valid time. Let's pick an available slot.";
  }
}
