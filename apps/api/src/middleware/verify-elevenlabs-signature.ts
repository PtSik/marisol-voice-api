import type { MiddlewareHandler } from 'hono';
import { hmacSHA256, timingSafeEqual } from '../lib/crypto';

interface ElevenLabsSignatureBindings {
  ELEVENLABS_WEBHOOK_SECRET: string;
}

export const verifyElevenLabsSignature: MiddlewareHandler<{
  Bindings: ElevenLabsSignatureBindings;
}> = async (c, next) => {
  const secret = c.env.ELEVENLABS_WEBHOOK_SECRET;
  const sigHeader = c.req.header('ElevenLabs-Signature');
  if (!sigHeader) {
    return c.json({ error: 'Missing ElevenLabs-Signature header' }, 401);
  }

  const parts = sigHeader.split(',');
  const tPart = parts.find((p) => p.startsWith('t='));
  const v0Part = parts.find((p) => p.startsWith('v0='));

  if (!tPart || !v0Part) {
    return c.json({ error: 'Malformed ElevenLabs-Signature header' }, 401);
  }

  const timestamp = tPart.slice(2);
  const receivedSig = v0Part;

  const reqTimestampMs = Number(timestamp) * 1000;
  if (Math.abs(Date.now() - reqTimestampMs) > 1800 * 1000) {
    return c.json({ error: 'Timestamp out of tolerance' }, 401);
  }

  const rawBody = await c.req.text();
  const expected = await hmacSHA256(secret, `${timestamp}.${rawBody}`);

  if (!timingSafeEqual(receivedSig, expected)) {
    return c.json({ error: 'Signature mismatch' }, 401);
  }

  await next();
};
