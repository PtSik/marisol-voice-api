import { describe, expect, it } from 'bun:test';
import {
  bookingConfirmationSms,
  cancellationSms,
  normalizeSmsLanguage,
  reminderSms,
  rescheduleConfirmationSms,
  smsWhenLabel,
} from '../../lib/sms-templates';

const parts = {
  shopName: 'Barbarossa Barbershop',
  whenLabel: 'Jul 9, 2026, 2:30 PM',
  staff: 'Joe',
};

describe('normalizeSmsLanguage', () => {
  it('accepts es', () => expect(normalizeSmsLanguage('es')).toBe('es'));
  it('defaults everything else to en', () => {
    for (const v of ['en', 'ES', 'spanish', undefined, null, 42, '']) {
      if (v === 'en') expect(normalizeSmsLanguage(v)).toBe('en');
      else if (v !== 'es') expect(normalizeSmsLanguage(v)).toBe('en');
    }
  });
});

describe('english templates match the legacy inline texts exactly', () => {
  it('booking', () => {
    expect(bookingConfirmationSms('en', { ...parts, code: '123456' })).toBe(
      'Barbarossa Barbershop: Appointment confirmed on Jul 9, 2026, 2:30 PM with Joe. Verification code: 123456. Keep this to cancel or reschedule.',
    );
  });
  it('reschedule', () => {
    expect(rescheduleConfirmationSms('en', { ...parts, code: '654321' })).toBe(
      'Barbarossa Barbershop: Your appointment has been rescheduled to Jul 9, 2026, 2:30 PM with Joe. New verification code: 654321. Keep this to cancel or reschedule.',
    );
  });
  it('cancel', () => {
    expect(cancellationSms('en', parts)).toBe(
      'Barbarossa Barbershop: Your appointment on Jul 9, 2026, 2:30 PM with Joe has been cancelled.',
    );
  });
  it('reminder', () => {
    expect(reminderSms('en', parts)).toBe(
      'Barbarossa Barbershop: Reminder: your appointment is on Jul 9, 2026, 2:30 PM with Joe. Need to change it? Just give us a call.',
    );
  });
});

describe('spanish templates', () => {
  it('are complete and interpolated', () => {
    for (const body of [
      bookingConfirmationSms('es', { ...parts, code: '123456' }),
      rescheduleConfirmationSms('es', { ...parts, code: '654321' }),
      cancellationSms('es', parts),
      reminderSms('es', parts),
    ]) {
      expect(body).toContain('Barbarossa Barbershop');
      expect(body).toContain('Joe');
      expect(body).not.toContain('undefined');
      expect(body).not.toMatch(/appointment|Verification|cancelled|Reminder/);
    }
  });
  it('booking and reschedule carry the code', () => {
    expect(bookingConfirmationSms('es', { ...parts, code: '123456' })).toContain('123456');
    expect(rescheduleConfirmationSms('es', { ...parts, code: '654321' })).toContain('654321');
  });
});

describe('smsWhenLabel', () => {
  const utcMs = Date.UTC(2026, 6, 9, 18, 30); // 2:30 PM in New York (EDT)
  it('formats in en-US', () => {
    expect(smsWhenLabel(utcMs, 'America/New_York', 'en')).toBe('Jul 9, 2026, 2:30 PM');
  });
  it('formats in es-US with the same local time', () => {
    const label = smsWhenLabel(utcMs, 'America/New_York', 'es');
    expect(label).toContain('2026');
    expect(label).toContain('2:30');
    expect(label.toLowerCase()).toContain('jul');
  });
  it('respects DST transitions', () => {
    const winter = Date.UTC(2026, 0, 9, 19, 30); // EST (UTC-5)
    expect(smsWhenLabel(winter, 'America/New_York', 'en')).toBe('Jan 9, 2026, 2:30 PM');
  });
});
