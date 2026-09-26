import type { Context } from 'hono';
import { deferCalendarWrite, gcalDeleteEvent, resolveRouting } from '../../lib/gcal';
import { spokenDateTimeLabel } from '../../lib/hours';
import { sendSms } from '../../lib/sms';
import { cancellationSms, normalizeSmsLanguage, smsWhenLabel } from '../../lib/sms-templates';
import { releaseCode, verifyCode } from '../../lib/verification';
import type {
  CancelAppointmentParams,
  ElevenLabsToolWebhookResponse,
  WorkerBindings,
} from '../../types';
import type { ToolRequest } from './index';

export async function handleCancelAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  { params, shop, db, hasPhone }: ToolRequest<CancelAppointmentParams>,
): Promise<Response> {
  const { booking_id, code, reason } = params;

  if (!hasPhone) {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: "You're all set — in the real product I'd text your confirmation now.",
      success: true,
    });
  }

  const { data: booking } = await db
    .from('bookings')
    .select(
      'id, shop_id, customer_phone, staff, start_at, status, gcal_event_id, gcal_calendar_id, language, sms_consent_at',
    )
    .eq('id', booking_id)
    .single();

  if (!booking || booking.shop_id !== shop.id) {
    return c.json<ElevenLabsToolWebhookResponse>({ result: 'Booking not found.', success: false });
  }
  if (booking.status === 'cancelled') {
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'This appointment is already cancelled.',
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

  const hasCalendar =
    shop.integration === 'google_calendar' && !!shop.integration_credentials_encrypted;

  const { error: cancelError } = await db
    .from('bookings')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
      cancellation_reason: reason ?? null,
      // The repair cron reaches even an event whose id never made it to the DB, via the
      // deterministic event id — so the flag goes up whenever the shop has a calendar.
      ...(hasCalendar ? { gcal_sync_pending: true } : {}),
    })
    .eq('id', booking_id);

  if (cancelError) {
    await releaseCode(db, booking_id, code);
    return c.json<ElevenLabsToolWebhookResponse>({
      result: 'I could not cancel the appointment just now. Please try again in a moment.',
      success: false,
    });
  }

  if (hasCalendar && shop.integration_credentials_encrypted && booking.gcal_event_id) {
    const encryptedCreds = shop.integration_credentials_encrypted;
    const eventId = booking.gcal_event_id;
    // The calendar recorded on the booking wins: the mapping may have changed since.
    const calendarId = booking.gcal_calendar_id ?? resolveRouting(shop).write_calendar_id;
    deferCalendarWrite(
      c.executionCtx,
      c.env,
      { shopId: shop.id, encryptedCreds, calendarId },
      async (token) => {
        await gcalDeleteEvent(calendarId, token, eventId);
        await db
          .from('bookings')
          .update({ gcal_event_id: null, gcal_sync_pending: false })
          .eq('id', booking_id);
      },
    );
  }

  const language = normalizeSmsLanguage(params.language ?? booking.language);
  const smsLabel = smsWhenLabel(new Date(booking.start_at).getTime(), shop.timezone, language);
  const spokenLabel = spokenDateTimeLabel(new Date(booking.start_at).getTime(), shop.timezone);
  const smsSent = await sendSms(
    c.env,
    shop,
    booking.customer_phone,
    cancellationSms(language, {
      shopName: shop.name,
      whenLabel: smsLabel,
      staff: booking.staff,
    }),
    { consentAt: booking.sms_consent_at, db },
  );

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Your appointment ${spokenLabel} with ${booking.staff} has been cancelled.`,
    success: true,
    data: { cancelled: true, booking_id, original_start_time: booking.start_at, sms_sent: smsSent },
  });
}
