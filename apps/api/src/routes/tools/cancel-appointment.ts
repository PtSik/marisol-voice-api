import type { Context } from 'hono';
import { gcalDeleteEvent, getGCalClient } from '../../lib/gcal';
import { sendSms } from '../../lib/sms';
import { getSupabase } from '../../lib/supabase';
import { verifyCode } from '../../lib/verification';
import type {
  CancelAppointmentParams,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  ShopRow,
  WorkerBindings,
} from '../../types';

export async function handleCancelAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<
    CancelAppointmentParams | ElevenLabsToolWebhookRequest<CancelAppointmentParams>
  >();
  const params = ('parameters' in raw ? raw.parameters : raw) as CancelAppointmentParams;
  const { booking_id, code, reason } = params;

  const db = getSupabase(c.env);
  const { data: booking } = await db
    .from('bookings')
    .select('id, shop_id, customer_phone, staff, start_at, status, gcal_event_id')
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

  await db
    .from('bookings')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
      cancellation_reason: reason ?? null,
    })
    .eq('id', booking_id);

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
          await gcalDeleteEvent(gcal.calendar_id, gcal.token, eventId);
        } catch {
          // non-fatal
        }
      })(),
    );
  }

  const startLabel = new Date(booking.start_at).toLocaleString('en-US', {
    timeZone: shop.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const smsSent = await sendSms(
    c.env,
    shop.twilio_number,
    booking.customer_phone,
    `${shop.name}: Your appointment on ${startLabel} with ${booking.staff} has been cancelled.`,
  );

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Appointment on ${startLabel} with ${booking.staff} has been cancelled.`,
    success: true,
    data: { cancelled: true, booking_id, original_start_time: booking.start_at, sms_sent: smsSent },
  });
}
