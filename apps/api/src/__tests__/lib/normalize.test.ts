import { describe, expect, it } from 'bun:test';
import { tryToE164 } from '../../lib/normalize';

describe('normalize — tryToE164', () => {
  it('reads a US number written without a country code', () => {
    expect(tryToE164('(415) 555-2671')).toBe('+14155552671');
  });

  it('keeps an international number on its own country code', () => {
    expect(tryToE164('+44 20 7123 4567')).toBe('+442071234567');
  });

  it('leaves an E.164 number unchanged', () => {
    expect(tryToE164('+14155552671')).toBe('+14155552671');
  });

  it('answers null for something that is not a phone number', () => {
    expect(tryToE164('not-a-phone')).toBeNull();
  });
});
