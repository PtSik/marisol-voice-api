import { describe, expect, it } from 'bun:test';
import { hasPhoneContext } from '../../routes/tools/index';

describe('tools — hasPhoneContext', () => {
  it('is true when called_number is present (flat phone body)', () => {
    expect(hasPhoneContext({ called_number: '+14155552671', shop_id: 'shop-1' })).toBe(true);
  });

  it('is true when called_number is nested under parameters', () => {
    expect(hasPhoneContext({ parameters: { called_number: '+14155552671' } })).toBe(true);
  });

  it('is false for a browser/demo body carrying only shop_id', () => {
    expect(hasPhoneContext({ shop_id: 'shop-1' })).toBe(false);
  });

  it('is false when called_number is an unsubstituted template', () => {
    expect(hasPhoneContext({ called_number: '{{system__called_number}}' })).toBe(false);
  });

  it('is false for empty or non-object bodies', () => {
    expect(hasPhoneContext({})).toBe(false);
    expect(hasPhoneContext(undefined)).toBe(false);
    expect(hasPhoneContext(null)).toBe(false);
  });
});
