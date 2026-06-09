import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { verifyElevenLabsSignature } from '../../middleware/verify-elevenlabs-signature';

const WEBHOOK_SECRET = 'test-secret-key';

async function buildHmac(secret: string, timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeApp(secret: string) {
  const app = new Hono();
  app.use('*', verifyElevenLabsSignature(secret));
  app.post('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('verifyElevenLabsSignature middleware', () => {
  it('passes a valid signature', async () => {
    const app = makeApp(WEBHOOK_SECRET);
    const body = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = await buildHmac(WEBHOOK_SECRET, timestamp, body);
    const res = await app.request('/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': `t=${timestamp},v0=${hmac}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 for invalid HMAC', async () => {
    const app = makeApp(WEBHOOK_SECRET);
    const body = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await app.request('/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': `t=${timestamp},v0=deadbeefdeadbeef`,
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when timestamp is older than 1800 seconds', async () => {
    const app = makeApp(WEBHOOK_SECRET);
    const body = JSON.stringify({ event: 'test' });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 1801;
    const hmac = await buildHmac(WEBHOOK_SECRET, oldTimestamp, body);
    const res = await app.request('/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': `t=${oldTimestamp},v0=${hmac}`,
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when ElevenLabs-Signature header is missing', async () => {
    const app = makeApp(WEBHOOK_SECRET);
    const body = JSON.stringify({ event: 'test' });
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });
});
