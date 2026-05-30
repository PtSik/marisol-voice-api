import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { verifyToolSecret } from '../../middleware/verify-tool-secret';

function makeApp() {
  const app = new Hono<{ Bindings: { TOOLS_WEBHOOK_SECRET?: string } }>();
  app.use('*', verifyToolSecret());
  app.post('/tools/x', (c) => c.json({ result: 'ok', success: true }));
  return app;
}

const SECRET = 's3cret-value';

describe('verifyToolSecret middleware', () => {
  it('passes when the X-Tool-Secret header matches', async () => {
    const res = await makeApp().request(
      '/tools/x',
      { method: 'POST', headers: { 'X-Tool-Secret': SECRET } },
      { TOOLS_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
  });

  it('returns 401 when the header is wrong', async () => {
    const res = await makeApp().request(
      '/tools/x',
      { method: 'POST', headers: { 'X-Tool-Secret': 'nope' } },
      { TOOLS_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the header is missing', async () => {
    const res = await makeApp().request(
      '/tools/x',
      { method: 'POST' },
      { TOOLS_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
  });

  it('fails open (passes) when the secret is not configured', async () => {
    const res = await makeApp().request('/tools/x', { method: 'POST' }, {});
    expect(res.status).toBe(200);
  });
});
