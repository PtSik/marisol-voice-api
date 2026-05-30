import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '../lib/crypto';

export interface AdminAuthBindings {
  ADMIN_API_KEYS: string;
  ADMIN_IP_ALLOWLIST?: string;
}

export function adminAuth(): MiddlewareHandler<{ Bindings: AdminAuthBindings }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const validKeys = c.env.ADMIN_API_KEYS.split(',').map((k) => k.trim());
    if (!validKeys.some((k) => timingSafeEqual(k, token))) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    const ipAllowlist = c.env.ADMIN_IP_ALLOWLIST;
    if (ipAllowlist) {
      const clientIp = c.req.header('CF-Connecting-IP') ?? '';
      const allowed = ipAllowlist
        .split(',')
        .map((ip) => ip.trim())
        .includes(clientIp);
      if (!allowed) {
        return c.json({ error: 'IP not in allowlist' }, 403);
      }
    }

    await next();
  };
}
