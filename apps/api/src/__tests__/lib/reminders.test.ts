import { describe, expect, it } from 'bun:test';
import {
  type DueBooking,
  composeReminder,
  reminderWindow,
  runReminders,
} from '../../lib/reminders';
import type { WorkerBindings } from '../../types';

const shop = {
  name: 'Barbarossa Barbershop',
  timezone: 'America/New_York',
  twilio_number: '+18336596941',
  reminders_enabled: true,
  status: 'active',
};

const booking: DueBooking = {
  id: 'b1',
  customer_phone: '+15551234567',
  staff: 'Joe',
  service: 'Haircut',
  start_at: new Date(Date.UTC(2026, 6, 9, 18, 30)).toISOString(),
  language: 'en',
  shops: shop,
};

describe('reminderWindow', () => {
  it('spans 23h to 25h from now', () => {
    const now = Date.UTC(2026, 6, 8, 12, 0);
    const { from, to } = reminderWindow(now);
    expect(new Date(from).getTime() - now).toBe(23 * 3_600_000);
    expect(new Date(to).getTime() - now).toBe(25 * 3_600_000);
  });
});

describe('runReminders launch gate', () => {
  it('does not query or claim bookings while SMS is disabled', async () => {
    const result = await runReminders({ SMS_ENABLED: 'false' } as WorkerBindings);
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });
});

describe('composeReminder', () => {
  it('builds an english reminder', () => {
    const body = composeReminder(booking);
    expect(body).toContain('Reminder');
    expect(body).toContain('Joe');
    expect(body).toContain('2:30 PM');
  });
  it('builds a spanish reminder from booking language', () => {
    const body = composeReminder({ ...booking, language: 'es' });
    expect(body).toContain('Recordatorio');
    expect(body).not.toContain('Reminder');
  });
  it('returns null when the shop has reminders disabled', () => {
    expect(
      composeReminder({ ...booking, shops: { ...shop, reminders_enabled: false } }),
    ).toBeNull();
  });
  it('returns null when the shop join is missing', () => {
    expect(composeReminder({ ...booking, shops: null })).toBeNull();
  });
  it('returns null for a suspended shop', () => {
    expect(composeReminder({ ...booking, shops: { ...shop, status: 'suspended' } })).toBeNull();
  });
});
