import { describe, expect, it } from 'bun:test';
import { smsPreferenceAction } from '../../routes/twilio/sms';

describe('SMS preference keywords', () => {
  it('recognizes standard opt-out keywords case-insensitively', () => {
    expect(smsPreferenceAction(' stop ')).toBe('opted_out');
    expect(smsPreferenceAction('UNSUBSCRIBE')).toBe('opted_out');
  });

  it('recognizes opt-in keywords', () => {
    expect(smsPreferenceAction('START')).toBe('opted_in');
    expect(smsPreferenceAction('unstop')).toBe('opted_in');
  });

  it('leaves the preference untouched for HELP and INFO', () => {
    expect(smsPreferenceAction('HELP')).toBeNull();
    expect(smsPreferenceAction('info')).toBeNull();
  });

  it('prefers Twilio Advanced Opt-Out metadata', () => {
    expect(smsPreferenceAction('anything', 'STOP')).toBe('opted_out');
  });

  it('does not treat a keyword embedded in a sentence as an opt-out', () => {
    expect(smsPreferenceAction('please stop sending')).toBeNull();
  });
});
