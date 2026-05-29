import { describe, it, expect, beforeEach } from 'bun:test'

// Integration test — requires a real Supabase test project configured via env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (test project only)
// Run with: bun test --filter integration

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8787'

const VALID_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_API_KEY ?? 'test-admin-key'}`,
}

function makeBookingPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: `conv-${crypto.randomUUID()}`,
    shop_id: process.env.TEST_SHOP_ID ?? 'test-shop-id',
    customer_phone: '+15550001111',
    customer_name: 'Test Customer',
    service: 'Haircut',
    barber: 'John',
    start_at: new Date(Date.now() + 86_400_000).toISOString(),
    end_at: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
    ...overrides,
  }
}

describe('book-appointment integration', () => {
  it('creates a booking row for a new conversation_id', async () => {
    const payload = makeBookingPayload()
    const res = await fetch(`${BASE_URL}/tools/book-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { booking_id: string; confirmation_code: string; start_at: string }
    expect(body.booking_id).toBeDefined()
    expect(body.confirmation_code).toMatch(/^\d{4}$/)
    expect(body.start_at).toBeDefined()
  })

  it('is idempotent — same conversation_id returns same booking_id', async () => {
    const payload = makeBookingPayload()
    const first = await fetch(`${BASE_URL}/tools/book-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify(payload),
    })
    const second = await fetch(`${BASE_URL}/tools/book-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify(payload),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = await first.json() as { booking_id: string }
    const secondBody = await second.json() as { booking_id: string }
    expect(secondBody.booking_id).toBe(firstBody.booking_id)
  })

  it('rejects double-booking same slot with different conversation_id', async () => {
    const sharedSlot = {
      shop_id: process.env.TEST_SHOP_ID ?? 'test-shop-id',
      barber: 'John',
      start_at: new Date(Date.now() + 172_800_000).toISOString(), // day 2 to avoid collision with above
      end_at: new Date(Date.now() + 172_800_000 + 3_600_000).toISOString(),
    }
    const first = await fetch(`${BASE_URL}/tools/book-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify(makeBookingPayload(sharedSlot)),
    })
    expect(first.status).toBe(200)

    // Different conversation_id, same slot — should conflict
    const second = await fetch(`${BASE_URL}/tools/book-appointment`, {
      method: 'POST',
      headers: VALID_HEADERS,
      body: JSON.stringify(makeBookingPayload({ ...sharedSlot, conversation_id: `conv-${crypto.randomUUID()}` })),
    })
    expect(second.status).toBe(409)
  })
})
