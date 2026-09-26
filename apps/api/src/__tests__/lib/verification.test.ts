import { beforeEach, describe, expect, it } from 'bun:test';
import { generateCode, hashCode, verifyCode } from '../../lib/verification';

// In-memory Supabase stub — emulates the one PostgREST chain verifyCode uses:
//   .update(values).eq().eq().is().gt().select()
// and applies it to the record, so a second verification sees the first one's `used_at`.
type Filter = ['eq' | 'is' | 'gt', string, unknown];

function recordMatches(rec: Record<string, unknown>, filters: Filter[]): boolean {
  for (const [op, col, val] of filters) {
    if (op === 'gt') {
      if (!(String(rec[col]) > String(val))) return false;
    } else if (rec[col] !== val) {
      return false;
    }
  }
  return true;
}

function makeSupabaseStub(record: Record<string, unknown>) {
  return {
    from: () => {
      const filters: Filter[] = [];
      let values: Record<string, unknown> = {};
      const builder = {
        update: (v: Record<string, unknown>) => {
          values = v;
          return builder;
        },
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
        select: async () => {
          if (!recordMatches(record, filters)) return { data: [], error: null };
          Object.assign(record, values);
          return { data: [{ id: record.id }], error: null };
        },
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

  it('consumes the code, so the same code never verifies twice', async () => {
    const record = {
      id: 'vc-5',
      booking_id: bookingId,
      code_hash: await hashCode('1234'),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    };
    const supabase = makeSupabaseStub(record);
    const results = await Promise.all([
      verifyCode(supabase, bookingId, '1234'),
      verifyCode(supabase, bookingId, '1234'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(record.used_at).not.toBeNull();
  });
});
