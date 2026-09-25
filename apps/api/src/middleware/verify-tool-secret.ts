import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '../lib/crypto';

export interface ToolSecretBindings {
  TOOLS_WEBHOOK_SECRET?: string;
}

export const verifyToolSecret: MiddlewareHandler<{ Bindings: ToolSecretBindings }> = async (
  c,
  next,
) => {
  const secret = c.env.TOOLS_WEBHOOK_SECRET;
  // Fail closed: an unset secret is a deploy mistake, not a licence to serve tool calls
  // unauthenticated. The binding is optional in the type, so only this check stops a worker
  // deployed without it from answering anyone who finds the URL.
  if (!secret) {
    console.error('[verifyToolSecret] TOOLS_WEBHOOK_SECRET unset — refusing tool webhooks');
    return c.json(
      { result: 'Sorry, I cannot reach the booking system right now.', success: false },
      503,
    );
  }
  const provided = c.req.header('X-Tool-Secret') ?? '';
  if (!timingSafeEqual(provided, secret)) {
    return c.json({ result: 'Unauthorized.', success: false }, 401);
  }
  return next();
};
