import { describe, expect, it } from 'bun:test';
import { smsPreferenceAction } from '../../routes/twilio/sms';

describe('SMS preference keywords', () => {
  it('recognizes standard opt-out keywords case-insensitively', () => {
    expect(smsPreferenceAction(' stop ')).toBe('opted_out');
    expect(smsPreferenceAction('UNSUBSCRIBE')).toBe('opted_out');
  });

  it('recognizes opt-in and help keywords', () => {
    expect(smsPreferenceAction('START')).toBe('opted_in');
    expect(smsPreferenceAction('help')).toBe('help');
  });

  it('prefers Twilio Advanced Opt-Out metadata', () => {
    expect(smsPreferenceAction('anything', 'STOP')).toBe('opted_out');
  });

  it('does not treat a keyword embedded in a sentence as an opt-out', () => {
    expect(smsPreferenceAction('please stop sending')).toBeNull();
  });
});
