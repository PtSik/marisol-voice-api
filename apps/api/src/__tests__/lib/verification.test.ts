import { describe, it, expect, beforeEach } from 'bun:test'
import { generateCode, hashCode, verifyCode } from '../../lib/verification'

// In-memory Supabase stub
function makeSupabaseStub(record: Record<string, unknown> | null, updateOk = true) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: record, error: record ? null : { code: 'PGRST116' } }),
        }),
      }),
      update: () => ({
        eq: () => ({
          then: async (cb: (v: { error: null | object }) => unknown) =>
            cb({ error: updateOk ? null : new Error('update failed') }),
        }),
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof verifyCode>[0]
}

describe('verification — generateCode', () => {
  it('returns a 4-digit numeric string', () => {
    const code = generateCode()
    expect(code).toMatch(/^\d{4}$/)
  })
})

describe('verification — hashCode', () => {
  it('is deterministic', async () => {
    const a = await hashCode('1234')
    const b = await hashCode('1234')
    expect(a).toBe(b)
  })

  it('differs for different inputs', async () => {
    const a = await hashCode('1234')
    const b = await hashCode('5678')
    expect(a).not.toBe(b)
  })
})

describe('verification — verifyCode', () => {
  const bookingId = 'booking-abc'

  it('returns true for correct code on valid record', async () => {
    const codeHash = await hashCode('1234')
    const record = {
      id: 'vc-1',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    }
    const supabase = makeSupabaseStub(record)
    const result = await verifyCode(supabase, bookingId, '1234')
    expect(result).toBe(true)
  })

  it('returns false for wrong code', async () => {
    const codeHash = await hashCode('1234')
    const record = {
      id: 'vc-2',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    }
    const supabase = makeSupabaseStub(record)
    const result = await verifyCode(supabase, bookingId, '9999')
    expect(result).toBe(false)
  })

  it('returns false for expired code', async () => {
    const codeHash = await hashCode('1234')
    const record = {
      id: 'vc-3',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() - 60_000).toISOString(), // past
      used_at: null,
    }
    const supabase = makeSupabaseStub(record)
    const result = await verifyCode(supabase, bookingId, '1234')
    expect(result).toBe(false)
  })

  it('returns false when code already used', async () => {
    const codeHash = await hashCode('1234')
    const record = {
      id: 'vc-4',
      booking_id: bookingId,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: new Date().toISOString(), // already used
    }
    const supabase = makeSupabaseStub(record)
    const result = await verifyCode(supabase, bookingId, '1234')
    expect(result).toBe(false)
  })
})
