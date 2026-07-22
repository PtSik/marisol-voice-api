import { describe, expect, it } from 'bun:test';
import worker from '../../index';
import { hmacSHA256 } from '../../lib/crypto';
import type { WorkerBindings } from '../../types';

// Empty SUPABASE_URL makes the shop lookup throw, so a signed request surfaces as a 500 —
// enough to tell "signature accepted" from "signature rejected" without a live database.
const env = {
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_API_KEYS: 'testkey',
  ENCRYPTION_KEY: 'a'.repeat(64),
} as unknown as WorkerBindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SHOP_ID = '11111111-1111-1111-1111-111111111111';

function get(query: string) {
  return worker.fetch(
    new Request(`https://example.com/integrations/google/select?${query}`),
    env,
    ctx,
  );
}

function post(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return worker.fetch(
    new Request('https://example.com/integrations/google/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }),
    env,
    ctx,
  );
}

describe('/integrations/google/select', () => {
  it('rejects a missing or wrong signature on GET', async () => {
    expect((await get(`shop_id=${SHOP_ID}`)).status).toBe(400);
    expect((await get(`shop_id=${SHOP_ID}&sig=nope`)).status).toBe(400);
  });

  it('rejects a missing or wrong signature on POST', async () => {
    expect((await post({ shop_id: SHOP_ID })).status).toBe(400);
    expect((await post({ shop_id: SHOP_ID, sig: 'nope' })).status).toBe(400);
  });

  it('accepts the same signature the connect link is minted with', async () => {
    const sig = await hmacSHA256('testkey', `gcal-connect:${SHOP_ID}`);
    const res = await get(`shop_id=${SHOP_ID}&sig=${sig}`);
    // Past the signature check the shop lookup throws on the empty Supabase URL.
    expect(res.status).toBe(500);
  });
});
