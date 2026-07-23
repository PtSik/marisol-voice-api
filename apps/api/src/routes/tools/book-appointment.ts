import type { Context } from 'hono';
import { splitByAttribution } from '../../lib/attribution';
import { logGcalFailure } from '../../lib/calendar-alerts';
import {
  deterministicEventId,
  gcalCreateEvent,
  getGCalClient,
  getStaffBusy,
  resolveRouting,
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
import { sendSms } from '../../lib/sms';
import {
  bookingConfirmationSms,
  normalizeSmsLanguage,
  smsWhenLabel,
} from '../../lib/sms-templates';
import { parseStaff, resolveStaffForBooking } from '../../lib/staff';
import { getSupabase } from '../../lib/supabase';
import { BOOKING_CODE_TTL_MINUTES, generateCode, storeCode } from '../../lib/verification';
import type {
  BookAppointmentParams,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  ShopRow,
  WorkerBindings,
} from '../../types';
import { hasPhoneContext } from './index';

export async function handleBookAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    BookAppointmentParams | ElevenLabsToolWebhookRequest<BookAppointmentParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as BookAppointmentParams;
  const conversationId =
    c.req.header('X-Conversation-Id') ??
    ('conversation_id' in raw ? raw.conversation_id : '') ??
    '';
  const {
    staff_name,
    start_time,
    duration_minutes,
    customer_phone,
    customer_name,
    service,
    notes,
  } = params;
  const language = normalizeSmsLanguage(params.language);

  if (!hasPhoneContext(raw)) {
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

  const resolved = resolveStaffForBooking(shop.staff_json, staff_name);
  if ('unknown' in resolved) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: `I don't have anyone by that name. We have ${resolved.unknown.join(', ')} — who would you like?`,
      success: false,
    });
  }
  const member = resolved.member;

  const validation = validateBookingTime(shop, start_time, duration_minutes, member);
  if (!validation.ok) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: bookingTimeError(validation.reason, staff_name),
      success: false,
    });
  }

  const startMs = new Date(start_time).getTime();
  const endMs = startMs + duration_minutes * 60000;
  const endAt = new Date(endMs).toISOString();
  const startDateStr = new Date(startMs).toLocaleDateString('en-CA', { timeZone: shop.timezone });
  const confirmedEnd = localIso(endMs, tzOffsetMinutes(startDateStr, shop.timezone));

  const db = getSupabase(c.env);

  // Race guard against foreign calendar events (Booksy / manual GCal entries) — the GiST
  // EXCLUDE only catches our own bookings. Our mirrored events are deduped by gcal_event_id.
  if (shop.integration === 'google_calendar' && shop.integration_credentials_encrypted) {
    const [ownRes, busy] = await Promise.all([
      db
        .from('bookings')
        .select('gcal_event_id')
        .eq('shop_id', shop.id)
        .eq('status', 'confirmed')
        .lt('start_at', endAt)
        .gt('end_at', start_time),
      getStaffBusy(c.env, shop, start_time, endAt, {
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      }),
    ]);
    const ownEventIds = new Set(
      (ownRes.data ?? []).map((b) => b.gcal_event_id).filter((id): id is string => !!id),
    );
    const foreign = splitByAttribution(
      busy.shared.filter((b) => !ownEventIds.has(b.id)),
      busy.perStaff,
      resolveRouting(shop).attribution,
      parseStaff(shop.staff_json),
    );
    const blocking = [...foreign.shared, ...(member ? (foreign.perStaff[member.id] ?? []) : [])];
    if (blocking.some((b) => b.start < endMs && b.end > startMs)) {
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
      staff: staff_name,
      service: service ?? null,
      start_at: start_time,
      end_at: endAt,
      notes: notes ?? null,
      language,
      idempotency_key:
        conversationId && !conversationId.includes('{{') ? `${conversationId}:${start_time}` : null,
      status: 'confirmed',
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
  await storeCode(db, booking.id, code, BOOKING_CODE_TTL_MINUTES);

  const smsLabel = smsWhenLabel(startMs, shop.timezone, language);
  const spokenLabel = spokenDateTimeLabel(startMs, shop.timezone);
  const smsSent = await sendSms(
    c.env,
    shop.twilio_number,
    normalizedPhone,
    bookingConfirmationSms(language, {
      shopName: shop.name,
      whenLabel: smsLabel,
      staff: staff_name,
      code,
    }),
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

function spokenCode(code: string): string {
  return code.split('').join(' ');
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
