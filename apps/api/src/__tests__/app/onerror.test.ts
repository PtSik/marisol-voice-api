import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import type { WorkerBindings } from '../../types';

// Empty SUPABASE_URL makes createClient() throw inside the handlers — a realistic
// unhandled-throw path. onError must convert a /tools/* throw to a tool-shaped 200
// so the ElevenLabs agent can speak gracefully instead of hitting dead air, while
// other routes keep a real error status.
const env = {
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_API_KEYS: 'testkey',
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function request(path: string, init: RequestInit) {
  return worker.fetch(new Request(`https://example.com${path}`, init), env, ctx);
}

describe('app.onError', () => {
  it('returns a tool-shaped 200 when a /tools/* handler throws', async () => {
    const res = await request('/tools/check_availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; success: boolean };
    expect(body.success).toBe(false);
    expect(typeof body.result).toBe('string');
  });

  it('returns a 500 for non-tool routes that throw', async () => {
    const res = await request('/admin/shops', {
      method: 'GET',
      headers: { Authorization: 'Bearer testkey' },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });
});
