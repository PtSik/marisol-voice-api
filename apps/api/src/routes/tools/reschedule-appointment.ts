import type { Context } from 'hono';
import { splitByAttribution } from '../../lib/attribution';
import { logGcalFailure } from '../../lib/calendar-alerts';
import {
  gcalPatchEvent,
  getGCalClient,
  getStaffBusy,
  resolveRouting,
  writeCalendarFor,
} from '../../lib/gcal';
import { type BookingTimeReason, spokenDateTimeLabel, validateBookingTime } from '../../lib/hours';
import { serviceDuration } from '../../lib/service-catalog';
import { sendSms } from '../../lib/sms';
import {
  normalizeSmsLanguage,
  rescheduleConfirmationSms,
  smsWhenLabel,
} from '../../lib/sms-templates';
import { findStaff, parseStaff } from '../../lib/staff';
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
    .select(
      'id, shop_id, customer_phone, staff, service, start_at, end_at, gcal_event_id, gcal_calendar_id, status, language',
    )
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
  const configuredDuration = serviceDuration(shop.service_catalog, booking.service);
  if (configuredDuration === null)
    return c.json<ElevenLabsToolWebhookResponse>({
      success: false,
      result:
        'This appointment’s service needs to be checked by the business before it can be moved. The original appointment is unchanged.',
    });
  const durationMinutes =
    configuredDuration ??
    new_duration_minutes ??
    Math.round((new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime()) / 60000);

  const requestedStaff = new_staff_name ?? booking.staff;
  const member = findStaff(shop.staff_json, requestedStaff);
  if (!member && parseStaff(shop.staff_json).length > 0)
    return c.json<ElevenLabsToolWebhookResponse>({
      success: false,
      result: 'Please choose an existing team member.',
    });
  const staff = member?.name ?? requestedStaff;
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

  const language = normalizeSmsLanguage(params.language ?? booking.language);
  const newEndAt = new Date(
    new Date(new_start_time).getTime() + durationMinutes * 60000,
  ).toISOString();

  const hasCalendar =
    shop.integration === 'google_calendar' && !!shop.integration_credentials_encrypted;

  if (shop.integration === 'google_calendar') {
    const routing = resolveRouting(shop);
    if (
      booking.gcal_event_id &&
      writeCalendarFor(shop, member?.id) !== (booking.gcal_calendar_id ?? routing.write_calendar_id)
    ) {
      return c.json<ElevenLabsToolWebhookResponse>({
        success: false,
        result:
          "Changing this appointment to another person's calendar needs help from the business. The original appointment is unchanged.",
      });
    }
    const [own, busy] = await Promise.all([
      db
        .from('bookings')
        .select('gcal_event_id')
        .eq('shop_id', shop.id)
        .eq('status', 'confirmed')
        .lt('start_at', newEndAt)
        .gt('end_at', new_start_time),
      getStaffBusy(c.env, shop, new_start_time, newEndAt, {
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      }),
    ]);
    if (own.error || busy.unavailable)
      return c.json<ElevenLabsToolWebhookResponse>({
        success: false,
        result:
          'I can’t verify the calendar right now. Your original appointment is unchanged. Please try again shortly.',
      });
    const ownIds = new Set((own.data ?? []).map((b) => b.gcal_event_id));
    if (booking.gcal_event_id) ownIds.add(booking.gcal_event_id);
    const foreign = splitByAttribution(
      busy.shared.filter((b) => !ownIds.has(b.id)),
      Object.fromEntries(
        Object.entries(busy.perStaff).map(([id, entries]) => [
          id,
          entries.filter((b) => !ownIds.has(b.id)),
        ]),
      ),
      routing.attribution,
      parseStaff(shop.staff_json),
    );
    const blocking = [...foreign.shared, ...(member ? (foreign.perStaff[member.id] ?? []) : [])];
    if (
      blocking.some(
        (b) => b.start < new Date(newEndAt).getTime() && b.end > new Date(new_start_time).getTime(),
      )
    )
      return c.json<ElevenLabsToolWebhookResponse>({
        success: false,
        result:
          'That time is unavailable. Your original appointment is unchanged. Please choose another time.',
      });
  }

  const valid = await verifyCode(db, booking_id, code);
  if (!valid) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'Invalid or expired verification code.',
      success: false,
    });
  }

  const { error } = await db
    .from('bookings')
    .update({
      start_at: new_start_time,
      end_at: newEndAt,
      staff,
      language,
      updated_at: new Date().toISOString(),
      // Also covers a booking whose original create failed: the repair cron will create
      // the event at the new time instead of patching a missing one.
      ...(hasCalendar ? { gcal_sync_pending: true } : {}),
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

  if (hasCalendar && shop.integration_credentials_encrypted && booking.gcal_event_id) {
    const encryptedCreds = shop.integration_credentials_encrypted;
    const eventId = booking.gcal_event_id;
    const calendarId = booking.gcal_calendar_id ?? resolveRouting(shop).write_calendar_id;
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const gcal = await getGCalClient(c.env, encryptedCreds);
          await gcalPatchEvent(
            calendarId,
            gcal.token,
            eventId,
            new_start_time,
            newEndAt,
            shop.timezone,
          );
          // Guarded on status: a cancel landing mid-flight re-raises the flag for the
          // repair cron, and this clear must not race it back down.
          await db
            .from('bookings')
            .update({ gcal_sync_pending: false })
            .eq('id', booking_id)
            .eq('status', 'confirmed');
        } catch (err) {
          await logGcalFailure(c.env, shop.id, {
            op: 'write',
            calendar_id: calendarId,
            message: err instanceof Error ? err.message : String(err),
          });
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
