import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { handleEscalate } from '../../routes/tools/escalate';
import type { ToolRequest } from '../../routes/tools/index';
import type { EscalateParams, ShopRow, WorkerBindings } from '../../types';

const realShop = {
  id: 'shop-real',
  name: 'Pampered Paws Pet Grooming',
  twilio_number: '+17545550100',
  escalation_phone: '+13055550111',
  owner_escalation_phone: '+13055550222',
} as unknown as ShopRow;

const demoShop = { ...realShop, id: 'shop-demo', is_demo: true } as unknown as ShopRow;

// Supabase and SMS are reachable only past the demo guard, so a context that throws on `env`,
// `executionCtx` or the request's `db` is the assertion: if a demo call ever reaches the callback
// branch, the test fails with that access rather than silently texting in production.
function ctx(): Context<{ Bindings: WorkerBindings }> {
  return {
    json: (body: unknown) => Response.json(body),
    get env(): never {
      throw new Error('demo escalation reached env — the guard did not hold');
    },
    get executionCtx(): never {
      throw new Error('demo escalation reached sendSms — the guard did not hold');
    },
  } as unknown as Context<{ Bindings: WorkerBindings }>;
}

function toolRequest(shop: ShopRow, params: EscalateParams): ToolRequest<EscalateParams> {
  return {
    raw: { ...params },
    params,
    shop,
    hasPhone: true,
    conversationId: 'conv_test',
    get db(): never {
      throw new Error('demo escalation reached Supabase — the guard did not hold');
    },
  } as unknown as ToolRequest<EscalateParams>;
}

async function escalate(shop: ShopRow, params: EscalateParams) {
  const res = await handleEscalate(ctx(), toolRequest(shop, params));
  return (await res.json()) as {
    result: string;
    success: boolean;
    data?: Record<string, unknown>;
  };
}

async function callbackWhileSmsDisabled() {
  const context = {
    json: (body: unknown) => Response.json(body),
    env: { SMS_ENABLED: 'false' },
    get executionCtx(): never {
      throw new Error('disabled callback reached an async SMS send');
    },
  } as unknown as Context<{ Bindings: WorkerBindings }>;
  const params: EscalateParams = {
    escalation_type: 'callback',
    customer_phone: '+13055559999',
    reason: 'price question',
  };
  const res = await handleEscalate(context, {
    raw: { ...params },
    params,
    shop: realShop,
    hasPhone: true,
    conversationId: 'conv_test',
    // The SMS gate refuses before any insert, so touching the client is a failure.
    get db(): never {
      throw new Error('disabled callback reached Supabase');
    },
  } as unknown as ToolRequest<EscalateParams>);
  return (await res.json()) as {
    result: string;
    success: boolean;
    data?: Record<string, unknown>;
  };
}

describe('escalate — demo shops never reach a person', () => {
  it('does not hand back a transfer target', async () => {
    const body = await escalate(demoShop, { escalation_type: 'transfer', reason: 'wants a human' });

    expect(body.data?.transfer_to).toBeUndefined();
    expect(body.data?.escalated).toBe(false);
    expect(body.data?.demo).toBe(true);
  });

  it('does not text us or file a callback', async () => {
    // The throwing getters in `ctx` do the work: reaching the callback branch throws instead of
    // returning, so an awaited result at all means the guard held.
    const body = await escalate(demoShop, {
      escalation_type: 'callback',
      customer_phone: '+13055559999',
      reason: 'price question',
    });

    expect(body.data?.escalated).toBe(false);
  });

  it('answers with something speakable rather than a failure', async () => {
    const body = await escalate(demoShop, { escalation_type: 'transfer' });

    // `success: false` makes the agent read the failure out loud — worse demo than an honest line.
    expect(body.success).toBe(true);
    expect(body.result).toMatch(/demo/i);
    // Never promise a hand-off that cannot happen.
    expect(body.result).not.toMatch(/transferring|please hold|will be in touch/i);
  });
});

describe('escalate — real shops are untouched', () => {
  it('still returns the transfer target and the hold line', async () => {
    const body = await escalate(realShop, { escalation_type: 'transfer', reason: 'complaint' });

    expect(body.data?.transfer_to).toBe(realShop.escalation_phone);
    expect(body.data?.escalated).toBe(true);
    expect(body.result).toMatch(/Transferring you to Pampered Paws/);
  });

  it('treats a shop with no is_demo column as real', async () => {
    // Rows selected before migration 0014 come back without the field; `undefined` must not read as
    // "demo", or a paying client silently stops transferring callers.
    const legacy = { ...realShop } as Record<string, unknown>;
    legacy.is_demo = undefined;

    const body = await escalate(legacy as unknown as ShopRow, { escalation_type: 'transfer' });

    expect(body.data?.transfer_to).toBe(realShop.escalation_phone);
  });

  it('does not promise or file a callback while SMS is disabled', async () => {
    const body = await callbackWhileSmsDisabled();
    expect(body.success).toBe(true);
    expect(body.data?.escalated).toBe(false);
    expect(body.data?.callback_available).toBe(false);
    expect(body.result).toMatch(/aren't available/i);
    expect(body.result).not.toMatch(/will be in touch/i);
  });
});

// Migration 0024 drops callbacks.status. The insert must stop naming it: the SMS goes out only
// after the row lands, so an insert rejected by the contracted schema turns a promised callback
// into a transfer offer.
describe('escalate — the callback row against the contracted schema', () => {
  it('files a callback without a status column and confirms it to the caller', async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      from: (table: string) => ({
        // sendSms checks the opt-out list before dialling Twilio; nobody here has opted out.
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
        insert: (row: Record<string, unknown>) => {
          expect(table).toBe('callbacks');
          inserted = row;
          return {
            select: () => ({ single: async () => ({ data: { id: 'cb_1' }, error: null }) }),
          };
        },
        delete: () => ({
          eq: async () => {
            throw new Error('the row was deleted — the SMS was treated as failed');
          },
        }),
      }),
    };
    const smsShop = { ...realShop, sms_enabled: true } as unknown as ShopRow;
    const context = {
      json: (body: unknown) => Response.json(body),
      env: { SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' },
      executionCtx: { waitUntil: () => {} },
    } as unknown as Context<{ Bindings: WorkerBindings }>;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 })) as typeof fetch;
    try {
      const params: EscalateParams = {
        escalation_type: 'callback',
        customer_phone: '+13055559999',
        reason: 'price question',
      };
      const res = await handleEscalate(context, {
        raw: { ...params },
        params,
        shop: smsShop,
        hasPhone: true,
        conversationId: 'conv_test',
        db,
      } as unknown as ToolRequest<EscalateParams>);
      const body = (await res.json()) as { data?: Record<string, unknown> };
      expect(body.data?.escalated).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(inserted).not.toBeNull();
    expect(Object.keys(inserted ?? {}).sort()).toEqual([
      'customer_phone',
      'elevenlabs_conversation_id',
      'reason',
      'shop_id',
    ]);
  });
});
