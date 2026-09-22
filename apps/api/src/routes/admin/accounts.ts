import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '../../lib/password';
import { getSupabase } from '../../lib/supabase';
import type { WorkerBindings } from '../../types';

const MUTABLE_FIELDS = new Set([
  'email',
  'google_sub',
  'shop_id',
  'lead_id',
  'last_login_at',
  'email_verified',
  'payout_method',
  'payout_handle',
]);

const PAYOUT_METHODS = new Set(['paypal', 'venmo', 'zelle']);

// Crockford base32 without I/L/O/U: referral codes get read aloud and typed by hand.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function referralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function normaliseEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function buildAccountUpdate(
  body: Record<string, unknown>,
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    if (key === 'email') {
      const email = normaliseEmail(value);
      if (!email) return { error: 'email must be a non-empty string' };
      update.email = email;
    } else if (key === 'payout_method') {
      if (typeof value !== 'string' || !PAYOUT_METHODS.has(value)) {
        return { error: 'invalid payout_method' };
      }
      update.payout_method = value;
    } else if (key === 'payout_handle') {
      const handle = typeof value === 'string' ? value.trim() : '';
      if (!handle) return { error: 'payout_handle must be a non-empty string' };
      update.payout_handle = handle;
    } else {
      update[key] = value;
    }
  }
  if (Object.keys(update).length === 0) return { error: 'No updatable fields provided' };
  return { update };
}

export const accountRoutes = new Hono<{ Bindings: WorkerBindings }>();

accountRoutes.get('/', async (c) => {
  const email = normaliseEmail(c.req.query('email'));
  if (!email) return c.json({ error: 'email query parameter is required' }, 400);

  const db = getSupabase(c.env);
  const { data, error } = await db.from('accounts').select('*').eq('email', email).maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Account not found' }, 404);
  return c.json({ account: data });
});

accountRoutes.get('/:id/shops', async (c) => {
  const db = getSupabase(c.env);
  const { data, error } = await db
    .from('shops')
    .select('*')
    .eq('account_id', c.req.param('id'))
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ shops: data });
});

accountRoutes.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const email = normaliseEmail(body.email);
  if (!email) return c.json({ error: 'Missing required field: email' }, 400);

  const passwordHash =
    typeof body.password === 'string' && body.password
      ? await hashPassword(body.password)
      : undefined;

  const db = getSupabase(c.env);
  const existing = await db.from('accounts').select('*').eq('email', email).maybeSingle();
  if (existing.error) return c.json({ error: existing.error.message }, 500);
  // Get-or-create is what provisioning wants, but a sign-up carries a password: handing that caller
  // the existing row would let it mint a session on an account whose password it never proved.
  if (existing.data) {
    if (passwordHash) return c.json({ error: 'Account already exists' }, 409);
    return c.json({ account: existing.data });
  }

  const insert = {
    email,
    referral_code: referralCode(),
    ...(body.shop_id ? { shop_id: body.shop_id } : {}),
    ...(body.lead_id ? { lead_id: body.lead_id } : {}),
    ...(passwordHash ? { password_hash: passwordHash } : {}),
  };
  const { data, error } = await db.from('accounts').insert(insert).select().single();
  if (error) {
    // Unique violation: either a concurrent provisioning won the race on the email, or the
    // random code collided. Re-reading by email settles the first and is harmless for the second.
    if (error.code === '23505') {
      const retry = await db.from('accounts').select('*').eq('email', email).maybeSingle();
      if (retry.data) {
        if (passwordHash) return c.json({ error: 'Account already exists' }, 409);
        return c.json({ account: retry.data });
      }
    }
    return c.json({ error: error.message }, 400);
  }
  return c.json({ account: data }, 201);
});

accountRoutes.post('/verify-password', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const email = normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return c.json({ error: 'email and password are required' }, 400);

  const db = getSupabase(c.env);
  const { data, error } = await db.from('accounts').select('*').eq('email', email).maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data || !data.password_hash) return c.json({ ok: false }, 401);

  const valid = await verifyPassword(password, data.password_hash);
  if (!valid) return c.json({ ok: false }, 401);

  return c.json({ ok: true, account: data });
});

accountRoutes.patch('/:id', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { password, ...rest } = body;
  const built = buildAccountUpdate(rest);
  const update: Record<string, unknown> = 'update' in built ? { ...built.update } : {};

  if (password !== undefined) {
    if (typeof password !== 'string' || !password) {
      return c.json({ error: 'password must be a non-empty string' }, 400);
    }
    update.password_hash = await hashPassword(password);
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: 'error' in built ? built.error : 'No updatable fields provided' }, 400);
  }

  const db = getSupabase(c.env);
  const { data, error } = await db
    .from('accounts')
    .update(update)
    .eq('id', c.req.param('id'))
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: 'Account not found' }, 404);
    return c.json({ error: error.message }, 400);
  }
  return c.json({ account: data });
});
