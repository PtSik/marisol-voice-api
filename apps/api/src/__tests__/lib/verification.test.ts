import { beforeEach, describe, expect, it } from 'bun:test';
import { generateCode, hashCode, verifyCode } from '../../lib/verification';

// In-memory Supabase stub — emulates the PostgREST filter chain used by verifyCode:
//   .select().eq().eq().is().gt().limit().single()  and  .update().eq()
type Filter = ['eq' | 'is' | 'gt', string, unknown];

function recordMatches(rec: Record<string, unknown> | null, filters: Filter[]): boolean {
  if (!rec) return false;
  for (const [op, col, val] of filters) {
    if (op === 'gt') {
      if (!(String(rec[col]) > String(val))) return false;
    } else if (rec[col] !== val) {
      return false;
    }
  }
  return true;
}

function makeSupabaseStub(record: Record<string, unknown> | null, updateOk = true) {
  return {
    from: () => {
      const filters: Filter[] = [];
      const builder = {
        select: () => builder,
        update: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push(['eq', col, val]);
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push(['is', col, val]);
          return builder;
        },
        gt: (col: string, val: unknown) => {
          filters.push(['gt', col, val]);
          return builder;
        },
        limit: () => builder,
        single: async () =>
          recordMatches(record, filters)
            ? { data: { id: record?.id }, error: null }
            : { data: null, error: { code: 'PGRST116' } },
        // biome-ignore lint/suspicious/noThenProperty: stub emulates an awaitable PostgREST builder
        then: (cb: (v: { error: null | Error }) => unknown) =>
          cb({ error: updateOk ? null : new Error('update failed') }),
      };
      return builder;
    },
  } as unknown as Parameters<typeof verifyCode>[0];
}

describe('verification — generateCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('verification — hashCode', () => {
  it('is deterministic', async () => {
    const a = await hashCode('1234');
    const b = await hashCode('1234');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await hashCode('1234');
    const b = await hashCode('5678');
    expect(a).not.toBe(b);
  });
});

describe('verification — verifyCode', () => {
  const bookingId = 'booking-abc';

  it('returns true for correct code on valid record', async () => {
    const codeHash = await hashCode('1234');
    const record = {
      id: 'vc-1',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    };
    const supabase = makeSupabaseStub(record);
    const result = await verifyCode(supabase, bookingId, '1234');
    expect(result).toBe(true);
  });

  it('returns false for wrong code', async () => {
    const codeHash = await hashCode('1234');
    const record = {
      id: 'vc-2',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    };
    const supabase = makeSupabaseStub(record);
    const result = await verifyCode(supabase, bookingId, '9999');
    expect(result).toBe(false);
  });

  it('returns false for expired code', async () => {
    const codeHash = await hashCode('1234');
    const record = {
      id: 'vc-3',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() - 60_000).toISOString(), // past
      used_at: null,
    };
    const supabase = makeSupabaseStub(record);
    const result = await verifyCode(supabase, bookingId, '1234');
    expect(result).toBe(false);
  });

  it('returns false when code already used', async () => {
    const codeHash = await hashCode('1234');
    const record = {
      id: 'vc-4',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: new Date().toISOString(), // already used
    };
    const supabase = makeSupabaseStub(record);
    const result = await verifyCode(supabase, bookingId, '1234');
    expect(result).toBe(false);
  });
});
