import worker from '../index';
import type { WorkerBindings } from '../types';

export const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// An empty SUPABASE_URL makes any DB call throw, so a request that reaches Supabase surfaces as 500 —
// that separates "passed validation" from "blocked at validation" (400) without a live database.
export const adminEnv = {
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_API_KEYS: 'testkey',
} as unknown as WorkerBindings;

export function adminCall(path: string, init: RequestInit = {}, auth = true) {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer testkey' } : {}),
      },
    }),
    adminEnv,
    ctx,
  );
}
