import { describe, expect, it } from 'bun:test';
import { CALLABLE_STATUSES, canServeCalls } from '../../lib/shop-status';

describe('canServeCalls', () => {
  it('serves an active shop and nothing else', () => {
    expect(canServeCalls('active')).toBe(true);
  });

  it('refuses rows the activation gate has not released', () => {
    expect(canServeCalls('suspended')).toBe(false);
    expect(canServeCalls('cancelled')).toBe(false);
    expect(canServeCalls(null)).toBe(false);
    expect(canServeCalls(undefined)).toBe(false);
  });

  // Retired in 0020/0021 and 0028. `trial` was the column default, so a status that answered the
  // phone on insert was a gate skipped by omission. `demo` only ever granted callability, which
  // `active` grants too — what stops a demo reaching a real person is `is_demo`.
  it('no longer serves a retired trial or demo row', () => {
    expect(canServeCalls('trial')).toBe(false);
    expect(canServeCalls('demo')).toBe(false);
  });

  // The three shop lookups filter in Postgres rather than through canServeCalls, so a status added
  // to one and not the other is a lookup that 404s a line the code believes it serves.
  it('is the same list the shop lookups filter on', () => {
    expect([...CALLABLE_STATUSES].every(canServeCalls)).toBe(true);
  });
});
