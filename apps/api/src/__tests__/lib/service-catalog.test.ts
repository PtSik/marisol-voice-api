import { describe, expect, it } from 'bun:test';
import { serviceDuration, servicesSummary, validServiceCatalog } from '../../lib/service-catalog';

const FIXED = [{ name: 'Small dog groom', duration_minutes: 60 }];
const SPREAD = [
  {
    name: 'Full groom',
    duration_minutes: 75,
    duration_max_minutes: 180,
    price: 65,
    price_max: 135,
  },
];

describe('server-owned service durations', () => {
  it('resolves the configured duration and never guesses for an unknown service', () => {
    expect(serviceDuration(FIXED, ' SMALL DOG GROOM ')).toBe(60);
    expect(serviceDuration(FIXED, 'Groom')).toBeNull();
    expect(serviceDuration(FIXED, undefined)).toBeNull();
  });

  it('books the top of a spread, so a long job cannot overlap the next caller', () => {
    expect(serviceDuration(SPREAD, 'Full groom')).toBe(180);
  });

  it('preserves legacy shops while rejecting a malformed configured catalog', () => {
    expect(serviceDuration(null, 'Groom')).toBeUndefined();
    expect(serviceDuration([], 'Groom')).toBeNull();
    expect(validServiceCatalog([{ name: 'Groom', duration_minutes: 0 }])).toBe(false);
    expect(validServiceCatalog([...FIXED, { ...FIXED[0], name: 'SMALL DOG GROOM' }])).toBe(false);
  });

  it('refuses bounds that cannot be spoken as a range', () => {
    const upper = (over: Record<string, unknown>) => [{ ...SPREAD[0], ...over }];
    expect(validServiceCatalog(upper({ duration_max_minutes: 30 }))).toBe(false);
    expect(validServiceCatalog(upper({ price_max: 10 }))).toBe(false);
    expect(validServiceCatalog(upper({ price: undefined }))).toBe(false);
    expect(validServiceCatalog(upper({ duration_max_minutes: 75.5 }))).toBe(false);
  });
});

describe('servicesSummary', () => {
  it('speaks a fixed service as one number and a spread as a range', () => {
    expect(servicesSummary(FIXED)).toBe('Small dog groom — 60 min');
    expect(servicesSummary(SPREAD)).toBe('Full groom — 75-180 min / $65-135');
  });

  it('collapses an upper bound equal to its lower bound', () => {
    expect(
      servicesSummary([{ name: 'Buzz cut', duration_minutes: 20, duration_max_minutes: 20 }]),
    ).toBe('Buzz cut — 20 min');
  });

  it('joins services with commas and a service’s own fields with a slash', () => {
    expect(
      servicesSummary([...FIXED, { name: 'Nail trim', duration_minutes: 15, price: 20 }]),
    ).toBe('Small dog groom — 60 min, Nail trim — 15 min / $20');
  });

  // An empty summary is the prompt's "I wasn't given this" and escalates, which beats advertising
  // a service booking would refuse.
  it('is empty rather than wrong when no catalog is configured', () => {
    expect(servicesSummary(null)).toBe('');
    expect(servicesSummary([])).toBe('');
  });
});
