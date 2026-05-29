import { describe, it, expect } from 'bun:test'

// Integration test — requires running API server with test Supabase project
// Run with: bun test --filter integration

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8787'

async function buildElevenLabsSignature(secret: string, body: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`))
  const hmac = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${timestamp},v0=${hmac}`
}

const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET ?? 'test-webhook-secret'

describe('personalization webhook integration', () => {
  it('returns dynamic_variables for a known twilio_number', async () => {
    const reqBody = JSON.stringify({ to_number: process.env.TEST_TWILIO_NUMBER ?? '+15550001234' })
    const sig = await buildElevenLabsSignature(WEBHOOK_SECRET, reqBody)
    const res = await fetch(`${BASE_URL}/webhooks/personalization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': sig,
      },
      body: reqBody,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { conversation_initiation_client_data: { dynamic_variables: Record<string, unknown> } }
    expect(body.conversation_initiation_client_data).toBeDefined()
    expect(body.conversation_initiation_client_data.dynamic_variables).toBeDefined()
  })

  it('returns 404 for an unknown twilio_number', async () => {
    const reqBody = JSON.stringify({ to_number: '+19999999999' })
    const sig = await buildElevenLabsSignature(WEBHOOK_SECRET, reqBody)
    const res = await fetch(`${BASE_URL}/webhooks/personalization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': sig,
      },
      body: reqBody,
    })
    expect(res.status).toBe(404)
  })

  it('returns 401 for invalid HMAC signature', async () => {
    const reqBody = JSON.stringify({ to_number: process.env.TEST_TWILIO_NUMBER ?? '+15550001234' })
    const res = await fetch(`${BASE_URL}/webhooks/personalization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': `t=${Math.floor(Date.now() / 1000)},v0=invalidhmac`,
      },
      body: reqBody,
    })
    expect(res.status).toBe(401)
  })
})
