import { Hono } from 'hono';
import { encrypt, hmacSHA256, timingSafeEqual } from '../../lib/crypto';
import { getSupabase } from '../../lib/supabase';
import type { WorkerBindings } from '../../types';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Signed with one of ADMIN_API_KEYS (shared with the landing worker) so only we can
// mint connect links — a shop_id alone must not be enough to hijack a calendar binding.
async function validSig(env: WorkerBindings, shopId: string, sig: string): Promise<boolean> {
  for (const key of env.ADMIN_API_KEYS.split(',')
    .map((k) => k.trim())
    .filter(Boolean)) {
    const expected = await hmacSHA256(key, `gcal-connect:${shopId}`);
    if (timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marisol · Calendar</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#FBF6EF;color:#241B14;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{background:#fff;border-radius:16px;padding:32px 28px;max-width:440px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 10px}p{color:#6F6457;line-height:1.55;margin:0}</style></head><body><div class="card">${body}</div></body></html>`;
}

export const googleIntegrationRoutes = new Hono<{ Bindings: WorkerBindings }>();

googleIntegrationRoutes.get('/start', async (c) => {
  const shopId = c.req.query('shop_id') ?? '';
  const sig = c.req.query('sig') ?? '';
  if (!shopId || !sig || !(await validSig(c.env, shopId, sig))) {
    return c.html(
      page(
        "<h1>This link isn't valid</h1><p>Please use the button from your welcome email, or reply to it and we'll help.</p>",
      ),
      400,
    );
  }
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID) {
    return c.html(
      page(
        "<h1>Calendar connect isn't available yet</h1><p>Please reply to your welcome email and we'll connect it for you.</p>",
      ),
      503,
    );
  }
  const redirectUri = `${new URL(c.req.url).origin}/integrations/google/callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: c.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: `${shopId}.${sig}`,
  }).toString();
  return c.redirect(authUrl.toString(), 302);
});

googleIntegrationRoutes.get('/callback', async (c) => {
  if (c.req.query('error')) {
    return c.html(
      page(
        "<h1>Calendar not connected</h1><p>You can try again from your welcome email whenever you're ready.</p>",
      ),
      200,
    );
  }
  const code = c.req.query('code');
  const [shopId, sig] = (c.req.query('state') ?? '').split('.');
  if (!code || !shopId || !sig || !(await validSig(c.env, shopId, sig))) {
    return c.html(
      page(
        '<h1>Something went wrong</h1><p>Please try the button from your welcome email again.</p>',
      ),
      400,
    );
  }

  const redirectUri = `${new URL(c.req.url).origin}/integrations/google/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    console.error('[gcal-oauth] token exchange failed:', await tokenRes.text());
    return c.html(
      page(
        "<h1>We couldn't finish connecting</h1><p>Please try again from your welcome email, or reply and we'll help.</p>",
      ),
      502,
    );
  }
  const tokens = await tokenRes.json<{ refresh_token?: string }>();
  if (!tokens.refresh_token) {
    return c.html(
      page(
        '<h1>Almost there</h1><p>Please reply to your welcome email so we can finish connecting your calendar.</p>',
      ),
      200,
    );
  }

  const creds = JSON.stringify({
    type: 'oauth',
    refresh_token: tokens.refresh_token,
    calendar_id: 'primary',
  });
  const encrypted = await encrypt(creds, c.env.ENCRYPTION_KEY);
  const { error } = await getSupabase(c.env)
    .from('shops')
    .update({ integration: 'google_calendar', integration_credentials_encrypted: encrypted })
    .eq('id', shopId);
  if (error) {
    console.error('[gcal-oauth] shop update failed:', error.message);
    return c.html(
      page(
        "<h1>We couldn't save the connection</h1><p>Please reply to your welcome email and we'll finish it.</p>",
      ),
      500,
    );
  }

  return c.html(
    page(
      '<h1>✅ Calendar connected</h1><p>Marisol will now book appointments straight into your Google Calendar. You can close this tab.</p>',
    ),
    200,
  );
});
