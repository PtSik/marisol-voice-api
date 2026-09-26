import type { Context } from 'hono';

// null rather than a throw, so each route answers a body that is not JSON with its own 400.
export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}
