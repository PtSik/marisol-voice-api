import { describe, expect, it } from 'bun:test';
import { CALLABLE_STATUSES, canServeCalls } from '../../lib/shop-status';

describe('canServeCalls', () => {
  it('serves active, legacy trial and sales demo rows', () => {
    expect(canServeCalls('active')).toBe(true);
    expect(canServeCalls('trial')).toBe(true);
    expect(canServeCalls('demo')).toBe(true);
  });

  it('refuses rows the activation gate has not released', () => {
    expect(canServeCalls('suspended')).toBe(false);
    expect(canServeCalls('cancelled')).toBe(false);
    expect(canServeCalls(null)).toBe(false);
    expect(canServeCalls(undefined)).toBe(false);
  });

  // The three shop lookups filter in Postgres rather than through canServeCalls, so a status added
  // to one and not the other is a lookup that 404s a line the code believes it serves.
  it('is the same list the shop lookups filter on', () => {
    expect([...CALLABLE_STATUSES].every(canServeCalls)).toBe(true);
  });
});
