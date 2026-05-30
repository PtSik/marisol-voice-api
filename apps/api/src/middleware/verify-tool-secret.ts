import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '../lib/crypto';

export interface ToolSecretBindings {
  TOOLS_WEBHOOK_SECRET?: string;
}

export function verifyToolSecret(): MiddlewareHandler<{ Bindings: ToolSecretBindings }> {
  return async (c, next) => {
    const secret = c.env.TOOLS_WEBHOOK_SECRET;
    // Fail open when unconfigured so the secret can be rolled out to the worker
    // before the ElevenLabs tool config sends the header — but make it loud.
    if (!secret) {
      console.warn(
        '[verifyToolSecret] TOOLS_WEBHOOK_SECRET unset — tool webhooks are UNAUTHENTICATED',
      );
      return next();
    }
    const provided = c.req.header('X-Tool-Secret') ?? '';
    if (!timingSafeEqual(provided, secret)) {
      return c.json({ result: 'Unauthorized.', success: false }, 401);
    }
    return next();
  };
}
