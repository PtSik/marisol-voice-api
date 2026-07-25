import { Hono } from 'hono';
import { getSupabase } from '../../lib/supabase';
import type { WorkerBindings } from '../../types';

const MUTABLE_FIELDS = new Set([
  'email',
  'google_sub',
  'shop_id',
  'lead_id',
  'last_login_at',
  'role',
]);

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

  const db = getSupabase(c.env);
  const existing = await db.from('accounts').select('*').eq('email', email).maybeSingle();
  if (existing.error) return c.json({ error: existing.error.message }, 500);
  if (existing.data) return c.json({ account: existing.data });

  const insert = {
    email,
    referral_code: referralCode(),
    ...(body.shop_id ? { shop_id: body.shop_id } : {}),
    ...(body.lead_id ? { lead_id: body.lead_id } : {}),
  };
  const { data, error } = await db.from('accounts').insert(insert).select().single();
  if (error) {
    // Unique violation: either a concurrent provisioning won the race on the email, or the
    // random code collided. Re-reading by email settles the first and is harmless for the second.
    if (error.code === '23505') {
      const retry = await db.from('accounts').select('*').eq('email', email).maybeSingle();
      if (retry.data) return c.json({ account: retry.data });
    }
    return c.json({ error: error.message }, 400);
  }
  return c.json({ account: data }, 201);
});

accountRoutes.patch('/:id', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const built = buildAccountUpdate(body);
  if ('error' in built) return c.json({ error: built.error }, 400);

  const db = getSupabase(c.env);
  const { data, error } = await db
    .from('accounts')
    .update(built.update)
    .eq('id', c.req.param('id'))
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: 'Account not found' }, 404);
    return c.json({ error: error.message }, 400);
  }
  return c.json({ account: data });
});
