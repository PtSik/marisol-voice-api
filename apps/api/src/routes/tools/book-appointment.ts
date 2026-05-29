import type { Context } from 'hono';
import type {
  WorkerBindings,
  ShopRow,
  ElevenLabsToolWebhookRequest,
  ElevenLabsToolWebhookResponse,
  BookAppointmentParams,
} from '../../types';
import { getSupabase } from '../../lib/supabase';
import { tryToE164 } from '../../lib/normalize';
import { generateCode, storeCode, BOOKING_CODE_TTL_MINUTES } from '../../lib/verification';
import { sendSms } from '../../lib/sms';
import { getGCalClient, gcalCreateEvent } from '../../lib/gcal';

export async function handleBookAppointment(
  c: Context<{ Bindings: WorkerBindings }>,
  shop: ShopRow,
): Promise<Response> {
  const raw = await c.req.json<BookAppointmentParams | ElevenLabsToolWebhookRequest<BookAppointmentParams>>();
  const params = ('parameters' in raw ? raw.parameters : raw) as BookAppointmentParams;
  const conversationId = c.req.header('X-Conversation-Id') ?? ('conversation_id' in raw ? raw.conversation_id : '') ?? '';
  const { staff_name, start_time, duration_minutes, customer_phone, customer_name, service, notes } = params;

  const normalizedPhone = tryToE164(customer_phone);
  if (!normalizedPhone) {
    return c.json<ElevenLabsToolWebhookResponse>({ result: 'Invalid customer phone number.', success: false });
  }

  const endAt = new Date(new Date(start_time).getTime() + duration_minutes * 60000).toISOString();

  const db = getSupabase(c.env);
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
      idempotency_key: conversationId && !conversationId.includes('{{') ? conversationId : null,
      status: 'confirmed',
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

  let gcalEventId: string | null = null;
  if (shop.integration === 'google_calendar' && shop.integration_credentials_encrypted) {
    try {
      const gcal = await getGCalClient(c.env, shop.integration_credentials_encrypted);
      gcalEventId = await gcalCreateEvent(
        gcal.calendar_id, gcal.token,
        `${service ?? 'Appointment'} — ${customer_name ?? normalizedPhone}`,
        `Phone: ${normalizedPhone}\nService: ${service ?? 'N/A'}`,
        start_time, endAt, shop.timezone,
      );
      await db.from('bookings').update({ gcal_event_id: gcalEventId }).eq('id', booking.id);
    } catch {
      // non-fatal — booking already succeeded
    }
  }

  const code = generateCode();
  await storeCode(db, booking.id, code, BOOKING_CODE_TTL_MINUTES);

  const startLabel = new Date(start_time).toLocaleString('en-US', {
    timeZone: shop.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const smsSent = await sendSms(
    c.env, shop.twilio_number, normalizedPhone,
    `${shop.name}: Appointment confirmed on ${startLabel} with ${staff_name}. Verification code: ${code}. Keep this to cancel or reschedule.`,
  );

  return c.json<ElevenLabsToolWebhookResponse>({
    result: `Appointment booked with ${staff_name} on ${startLabel}. Confirmation SMS sent.`,
    success: true,
    data: {
      booking_id: booking.id,
      confirmed_start_time: start_time,
      confirmed_end_time: endAt,
      staff_name,
      calendar_event_id: gcalEventId,
      sms_sent: smsSent,
    },
  });
}
