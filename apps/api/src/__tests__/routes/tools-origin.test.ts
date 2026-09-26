import { describe, expect, it } from 'bun:test';
import { readIdentifiers, resolveShopFrom } from '../../routes/tools/index';

function shopDb(shop: { id: string; status: string }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: shop }) }),
      }),
    }),
  } as unknown as Parameters<typeof resolveShopFrom>[0];
}

// A request has a phone behind it exactly when a real called_number came through; everything that
// writes or texts is gated on this.
const hasPhone = (raw: Record<string, unknown>) => !!readIdentifiers(raw).calledNumber;

describe('tools — phone context', () => {
  it('is present when called_number is present (flat phone body)', () => {
    expect(hasPhone({ called_number: '+14155552671', shop_id: 'shop-1' })).toBe(true);
  });

  it('is present when called_number is nested under parameters', () => {
    expect(hasPhone({ parameters: { called_number: '+14155552671' } })).toBe(true);
  });

  it('is absent for a browser/demo body carrying only shop_id', () => {
    expect(hasPhone({ shop_id: 'shop-1' })).toBe(false);
  });

  it('is absent when called_number is an unsubstituted template', () => {
    expect(hasPhone({ called_number: '{{system__called_number}}' })).toBe(false);
  });

  it('is absent for an empty body', () => {
    expect(hasPhone({})).toBe(false);
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

  it('refuses a retired trial shop', async () => {
    const shop = await resolveShopFrom(shopDb({ id: 'shop-1', status: 'trial' }), {
      shopId: 'shop-1',
      calledNumber: '',
      conversationId: '',
    });
    expect(shop).toBeNull();
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
