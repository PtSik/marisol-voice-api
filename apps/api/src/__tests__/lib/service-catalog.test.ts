import { describe, expect, it } from 'bun:test';
import { serviceDuration, validServiceCatalog } from '../../lib/service-catalog';
describe('server-owned service durations', () => {
  const catalog = [{ name: 'Small dog groom', duration_minutes: 60 }];
  it('resolves the configured duration and never guesses for an unknown service', () => {
    expect(serviceDuration(catalog, ' SMALL DOG GROOM ')).toBe(60);
    expect(serviceDuration(catalog, 'Groom')).toBeNull();
    expect(serviceDuration(catalog, undefined)).toBeNull();
  });
  it('preserves legacy shops while rejecting a malformed configured catalog', () => {
    expect(serviceDuration(null, 'Groom')).toBeUndefined();
    expect(serviceDuration([], 'Groom')).toBeNull();
    expect(validServiceCatalog([{ name: 'Groom', duration_minutes: 0 }])).toBe(false);
    expect(validServiceCatalog([...catalog, { ...catalog[0], name: 'SMALL DOG GROOM' }])).toBe(
      false,
    );
  });
});
