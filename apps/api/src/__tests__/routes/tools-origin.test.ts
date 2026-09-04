import { describe, expect, it } from 'bun:test';
import { hasPhoneContext, resolveShopFrom } from '../../routes/tools/index';

function shopDb(shop: { id: string; status: string }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: shop }) }),
      }),
    }),
  } as unknown as Parameters<typeof resolveShopFrom>[0];
}

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

describe('tools — assisted launch status gate', () => {
  it('resolves an active shop', async () => {
    const shop = await resolveShopFrom(shopDb({ id: 'shop-1', status: 'active' }), {
      shopId: 'shop-1',
      calledNumber: '',
      conversationId: '',
    });
    expect(shop?.id).toBe('shop-1');
  });

  it('keeps legacy trial shops callable during the assisted-launch migration', async () => {
    const shop = await resolveShopFrom(shopDb({ id: 'shop-1', status: 'trial' }), {
      shopId: 'shop-1',
      calledNumber: '',
      conversationId: '',
    });
    expect(shop?.id).toBe('shop-1');
  });

  it('refuses a suspended shop even when its id is valid', async () => {
    const shop = await resolveShopFrom(shopDb({ id: 'shop-1', status: 'suspended' }), {
      shopId: 'shop-1',
      calledNumber: '',
      conversationId: '',
    });
    expect(shop).toBeNull();
  });
});
