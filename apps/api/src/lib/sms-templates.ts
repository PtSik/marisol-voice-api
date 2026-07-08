export type SmsLanguage = 'en' | 'es';

export function normalizeSmsLanguage(value: unknown): SmsLanguage {
  return value === 'es' ? 'es' : 'en';
}

export function smsWhenLabel(utcMs: number, timezone: string, lang: SmsLanguage): string {
  return new Date(utcMs).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

interface BookingSmsParts {
  shopName: string;
  whenLabel: string;
  staff: string;
  code: string;
}

export function bookingConfirmationSms(lang: SmsLanguage, p: BookingSmsParts): string {
  if (lang === 'es') {
    return `${p.shopName}: Cita confirmada para el ${p.whenLabel} con ${p.staff}. Código de verificación: ${p.code}. Guárdelo para cancelar o cambiar su cita.`;
  }
  return `${p.shopName}: Appointment confirmed on ${p.whenLabel} with ${p.staff}. Verification code: ${p.code}. Keep this to cancel or reschedule.`;
}

export function rescheduleConfirmationSms(lang: SmsLanguage, p: BookingSmsParts): string {
  if (lang === 'es') {
    return `${p.shopName}: Su cita fue cambiada al ${p.whenLabel} con ${p.staff}. Nuevo código de verificación: ${p.code}. Guárdelo para cancelar o cambiar su cita.`;
  }
  return `${p.shopName}: Your appointment has been rescheduled to ${p.whenLabel} with ${p.staff}. New verification code: ${p.code}. Keep this to cancel or reschedule.`;
}

export function cancellationSms(lang: SmsLanguage, p: Omit<BookingSmsParts, 'code'>): string {
  if (lang === 'es') {
    return `${p.shopName}: Su cita del ${p.whenLabel} con ${p.staff} ha sido cancelada.`;
  }
  return `${p.shopName}: Your appointment on ${p.whenLabel} with ${p.staff} has been cancelled.`;
}

export function reminderSms(lang: SmsLanguage, p: Omit<BookingSmsParts, 'code'>): string {
  if (lang === 'es') {
    return `${p.shopName}: Recordatorio: su cita es el ${p.whenLabel} con ${p.staff}. ¿Necesita cambiarla? Llámenos.`;
  }
  return `${p.shopName}: Reminder: your appointment is on ${p.whenLabel} with ${p.staff}. Need to change it? Just give us a call.`;
}
