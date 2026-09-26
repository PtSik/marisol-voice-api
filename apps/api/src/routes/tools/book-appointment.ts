import type { Context } from 'hono';
import { logGcalFailure } from '../../lib/calendar-alerts';
import { checkCalendarConflict } from '../../lib/calendar-guard';
import {
  CALENDAR_SETUP_INCOMPLETE_RESULT,
  calendarSetupIncomplete,
  deterministicEventId,
  gcalCreateEvent,
  getGCalClient,
  writeCalendarFor,
} from '../../lib/gcal';
import {
  type BookingTimeReason,
  localIso,
  spokenDateTimeLabel,
  tzOffsetMinutes,
  validateBookingTime,
} from '../../lib/hours';
import { tryToE164 } from '../../lib/normalize';
import { serviceDuration } from '../../lib/service-catalog';
import { sendSms } from '../../lib/sms';
import {
  bookingConfirmationSms,
  normalizeSmsLanguage,
  smsWhenLabel,
  spokenCode,
} from '../../lib/sms-templates';
import { resolveStaffForBooking } from '../../lib/staff';
import { generateCode, storeCode } from '../../lib/verification';
import type {
  BookAppointmentParams,
  ElevenLabsToolWebhookResponse,
  WorkerBindings,
} from '../../types';
import type { ToolRequest } from './index';

export async function handleBookAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  { params, shop, db, hasPhone, conversationId }: ToolRequest<BookAppointmentParams>,
): Promise<Response> {
  if (calendarSetupIncomplete(shop)) {
    return c.json<ElevenLabsToolWebhookResponse>({
      success: false,
      result: CALENDAR_SETUP_INCOMPLETE_RESULT,
    });
  }
  const {
    staff_name,
    start_time,
    duration_minutes: requestedDuration,
    customer_phone,
    customer_name,
    service,
    notes,
  } = params;
  const configuredDuration = serviceDuration(shop.service_catalog, service);
  if (configuredDuration === null)
    return c.json<ElevenLabsToolWebhookResponse>({
      success: false,
      result:
        'Please choose a service from this business’s service list before booking. Do not invent a service or duration.',
    });
  const duration_minutes = configuredDuration ?? requestedDuration;
  const language = normalizeSmsLanguage(params.language);
  const smsConsentAt = params.sms_consent === true ? new Date().toISOString() : null;

  // Staff and opening-hours checks run before the web-demo short circuit below: both are pure
  // functions over the shop row we already hold, so the demo gets the same "no, we're closed
  // then" answer a real caller would instead of confirming a slot production would reject.
  const resolved = resolveStaffForBooking(shop.staff_json, staff_name);
  if ('unknown' in resolved) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: `I don't have anyone by that name. We have ${resolved.unknown.join(', ')} — who would you like?`,
      success: false,
    });
  }
  const { member, roster } = resolved;

  const validation = validateBookingTime(shop, start_time, duration_minutes, member);
  if (!validation.ok) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: bookingTimeError(validation.reason, staff_name),
      success: false,
    });
  }

  // Web demo: no caller ID, so there is no phone to key a customer on or text. Everything past
  // here writes to the database and sends SMS, which a demo must not do.
  if (!hasPhone) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: "You're all set — in the real product I'd text your confirmation now.",
      success: true,
    });
  }

  const normalizedPhone = tryToE164(customer_phone);
  if (!normalizedPhone) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'Invalid customer phone number.',
      success: false,
    });
  }

  const startMs = new Date(start_time).getTime();
  const endMs = startMs + duration_minutes * 60000;
  const endAt = new Date(endMs).toISOString();
  const startDateStr = new Date(startMs).toLocaleDateString('en-CA', { timeZone: shop.timezone });
  const confirmedEnd = localIso(endMs, tzOffsetMinutes(startDateStr, shop.timezone));

  if (shop.integration === 'google_calendar') {
    const guard = await checkCalendarConflict(c.env, db, shop, {
      startAt: start_time,
      endAt,
      member,
      roster,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    if (guard === 'unavailable') {
      return c.json<ElevenLabsToolWebhookResponse>({
        success: false,
        result:
          'I can’t verify the appointment calendar right now. No appointment has been made. Please try again shortly.',
      });
    }
    if (guard === 'blocked') {
      return c.json<ElevenLabsToolWebhookResponse>({
        result: 'That time was just taken. Let me check other options for you.',
        success: false,
      });
    }
  }

  const { data: booking, error } = await db
    .from('bookings')
    .insert({
      shop_id: shop.id,
      customer_phone: normalizedPhone,
      customer_name: customer_name ?? null,
      staff: member?.name ?? staff_name,
      service: service ?? null,
      start_at: start_time,
      end_at: endAt,
      notes: notes ?? null,
      language,
      idempotency_key:
        conversationId && !conversationId.includes('{{') ? `${conversationId}:${start_time}` : null,
      status: 'confirmed',
      sms_consent_at: smsConsentAt,
      // Set before the calendar write, cleared on its success — a swallowed failure or a
      // killed isolate leaves it up for the repair cron to finish the job.
      gcal_sync_pending:
        shop.integration === 'google_calendar' && !!shop.integration_credentials_encrypted,
    })
    .select()
    .single();

  if (error) {
    console.log('[book_appointment] insert error:', error.code, error.message);
    // 23P01 = exclusion_violation (GiST EXCLUDE double-booking)
    const isDoubleBook = error.code === '23P01';
    return c.json<ElevenLabsToolWebhookResponse>({
      result: isDoubleBook
        ? `That time with ${staff_name} is already booked. Please choose a different time.`
        : 'Failed to create booking. Please try again.',
      success: false,
    });
  }

  // Google Calendar is best-effort decoration — defer it off the caller's critical
  // path. The agent's response never depends on it succeeding.
  if (shop.integration === 'google_calendar' && shop.integration_credentials_encrypted) {
    const encryptedCreds = shop.integration_credentials_encrypted;
    const calendarId = writeCalendarFor(shop, member?.id);
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const gcal = await getGCalClient(c.env, encryptedCreds);
          const gcalEventId = await gcalCreateEvent(
            calendarId,
            gcal.token,
            `${service ?? 'Appointment'} — ${customer_name ?? normalizedPhone} (${member?.name ?? staff_name})`,
            `Phone: ${normalizedPhone}\nService: ${service ?? 'N/A'}`,
            start_time,
            endAt,
            shop.timezone,
            booking.id,
            deterministicEventId(booking.id),
          );
          // Guarded on status: a cancel landing mid-flight re-raises the flag, and clearing
          // it here would strand the just-created event with nothing left to repair it.
          await db
            .from('bookings')
            .update({
              gcal_event_id: gcalEventId,
              gcal_calendar_id: calendarId,
              gcal_sync_pending: false,
            })
            .eq('id', booking.id)
            .eq('status', 'confirmed');
        } catch (err) {
          // Non-fatal — the booking already succeeded — but silent failure here means the
          // shop's calendar quietly stops matching reality, so it has to be visible.
          await logGcalFailure(c.env, shop.id, {
            op: 'write',
            calendar_id: calendarId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
  }

  // The verification code is the cancel/reschedule contract — keep SMS inline so we
  // can confirm delivery and fall back to reading it aloud if the text fails.
  const code = generateCode();
  await storeCode(db, booking.id, code);

  const smsLabel = smsWhenLabel(startMs, shop.timezone, language);
  const spokenLabel = spokenDateTimeLabel(startMs, shop.timezone);
  const smsSent = await sendSms(
    c.env,
    shop,
    normalizedPhone,
    bookingConfirmationSms(language, {
      shopName: shop.name,
      whenLabel: smsLabel,
      staff: member?.name ?? staff_name,
      code,
    }),
    { consentAt: smsConsentAt, db },
  );

  const result = smsSent
    ? `Appointment booked with ${staff_name} ${spokenLabel}. I've texted your confirmation and a code to cancel or reschedule.`
    : `Appointment booked with ${staff_name} ${spokenLabel}. I couldn't send the text — your code to cancel or reschedule is ${spokenCode(code)}. Please write it down.`;

  return c.json<ElevenLabsToolWebhookResponse>({
    result,
    success: true,
    data: {
      booking_id: booking.id,
      confirmed_start_time: start_time,
      confirmed_end_time: confirmedEnd,
      staff_name,
      sms_sent: smsSent,
    },
  });
}

function bookingTimeError(reason: BookingTimeReason, staffName: string): string {
  switch (reason) {
    case 'past':
      return 'That time has already passed. Let me find the next opening for you.';
    case 'closed':
      return "We're closed that day. Could we pick another day?";
    case 'outside_hours':
      return "That's outside our opening hours. Let's pick a time while we're open.";
    case 'staff_away':
      return `${staffName} isn't working then. I can look at another time or someone else.`;
    default:
      return "That doesn't look like a valid time. Let's pick one of the available slots.";
  }
}
