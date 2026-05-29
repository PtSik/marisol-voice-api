import { describe, it, expect, beforeEach } from 'bun:test'
import { createClient } from '@supabase/supabase-js'

// Integration test — requires running API server with test Supabase project
// Run with: bun test --filter integration

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8787'
const VALID_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_API_KEY ?? 'test-admin-key'}`,
}

// Service role client bypasses RLS for test setup
const adminSupabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
)

async function createBookingAndGetCode(): Promise<{ bookingId: string; code: string }> {
  const res = await fetch(`${BASE_URL}/tools/book-appointment`, {
    method: 'POST',
    headers: VALID_HEADERS,
    body: JSON.stringify({
      conversation_id: `conv-${crypto.randomUUID()}`,
      shop_id: process.env.TEST_SHOP_ID ?? 'test-shop-id',
      customer_phone: '+15550002222',
      customer_name: 'Cancel Tester',
      service: 'Trim',
      barber: 'Jane',
      start_at: new Date(Date.now() + 259_200_000).toISOString(),
      end_at: new Date(Date.now() + 259_200_000 + 3_600_000).toISOString(),
    }),
  })
  const body = await res.json() as { booking_id: string; confirmation_code: string }
  return { bookingId: body.booking_id, code: body.confirmation_code }
}

async function expireVerificationCode(bookingId: string): Promise<void> {
  await adminSupabase
    .from('verification_codes')
    .update({ expires_at: new Date(Date.now() - 3_600_000).toISOString() })
    .eq('booking_id', bookingId)
}

describe('cancel-flow integration', () => {
  it('cancels booking with correct code', async () => {
    const { bookingId, code } = await createBookingAndGetCode()
    const res = await fetch(`${BASE_URL}/tools/cancel-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify({ booking_id: bookingId, code }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('returns wrong_code reason for incorrect code', async () => {
    const { bookingId } = await createBookingAndGetCode()
    const res = await fetch(`${BASE_URL}/tools/cancel-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify({ booking_id: bookingId, code: '0000' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; reason: string }
    expect(body.success).toBe(false)
    expect(body.reason).toBe('wrong_code')
  })

  it('returns expired reason when code expires_at is in the past', async () => {
    const { bookingId, code } = await createBookingAndGetCode()
    await expireVerificationCode(bookingId)
    const res = await fetch(`${BASE_URL}/tools/cancel-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify({ booking_id: bookingId, code }),
    })
    const body = await res.json() as { success: boolean; reason: string }
    expect(body.success).toBe(false)
    expect(body.reason).toBe('expired')
  })

  it('returns failure when code already used', async () => {
    const { bookingId, code } = await createBookingAndGetCode()
    await fetch(`${BASE_URL}/tools/cancel-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify({ booking_id: bookingId, code }),
    })
    const res = await fetch(`${BASE_URL}/tools/cancel-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify({ booking_id: bookingId, code }),
    })
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(false)
  })
})
