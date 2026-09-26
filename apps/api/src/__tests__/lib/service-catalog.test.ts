import { describe, expect, it } from 'bun:test';
import {
  availabilityDuration,
  serviceDuration,
  servicesSummary,
  validServiceCatalog,
} from '../../lib/service-catalog';

const FIXED = [{ name: 'Small dog groom', duration_minutes: 60 }];
const SPREAD = [{ name: 'Full groom', duration_minutes: 180, price: 65, price_max: 135 }];

describe('server-owned service durations', () => {
  it('resolves the configured duration and never guesses for an unknown service', () => {
    expect(serviceDuration(FIXED, ' SMALL DOG GROOM ')).toBe(60);
    expect(serviceDuration(FIXED, 'Groom')).toBeNull();
    expect(serviceDuration(FIXED, undefined)).toBeNull();
  });

  it('books the one duration the catalog holds, spread price or not', () => {
    expect(serviceDuration(SPREAD, 'Full groom')).toBe(180);
  });

  it('preserves legacy shops while rejecting a malformed configured catalog', () => {
    expect(serviceDuration(null, 'Groom')).toBeUndefined();
    expect(serviceDuration([], 'Groom')).toBeNull();
    expect(validServiceCatalog([{ name: 'Groom', duration_minutes: 0 }])).toBe(false);
    expect(validServiceCatalog([...FIXED, { ...FIXED[0], name: 'SMALL DOG GROOM' }])).toBe(false);
  });

  it('refuses a price ceiling that cannot be spoken as a range', () => {
    const upper = (over: Record<string, unknown>) => [{ ...SPREAD[0], ...over }];
    expect(validServiceCatalog(upper({ price_max: 10 }))).toBe(false);
    expect(validServiceCatalog(upper({ price: undefined }))).toBe(false);
  });
});

describe('servicesSummary', () => {
  it('speaks one duration, and a price range when the shop quotes one', () => {
    expect(servicesSummary(FIXED)).toBe('Small dog groom — 60 min');
    expect(servicesSummary(SPREAD)).toBe('Full groom — 180 min / $65-135');
  });

  it('collapses a price ceiling equal to its floor', () => {
    expect(
      servicesSummary([{ name: 'Buzz cut', duration_minutes: 20, price: 25, price_max: 25 }]),
    ).toBe('Buzz cut — 20 min / $25');
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

describe('availabilityDuration', () => {
  const CATALOG = [...FIXED, ...SPREAD];

  it('checks the length the named service will be booked for, not the agent’s guess', () => {
    expect(availabilityDuration(CATALOG, 'full groom', 30)).toBe(180);
  });

  it('holds out for the longest service when none is named', () => {
    expect(availabilityDuration(CATALOG, undefined, 30)).toBe(180);
  });

  it('refuses a service the shop does not sell', () => {
    expect(availabilityDuration(CATALOG, 'Teeth whitening', 30)).toBeNull();
  });

  it('keeps the agent’s duration for a shop without a catalog', () => {
    expect(availabilityDuration(null, 'Haircut', 45)).toBe(45);
  });
});
