import { Hono } from 'hono';
import { getSupabase } from '../../lib/supabase';
import type { WorkerBindings } from '../../types';

const STATUSES = new Set([
  'pending',
  'qualified',
  'claimable',
  'payout_requested',
  'paid_out',
  'void',
]);

const MUTABLE_FIELDS = new Set([
  'status',
  'payout_method',
  'payout_ref',
  'qualified_at',
  'mature_at',
  'settled_at',
  'referred_shop_id',
]);

const WITH_REFERRER =
  '*,referrer:accounts!referrals_referrer_account_id_fkey(id,email,lead_id,referral_code,payout_method,payout_handle)';

function normaliseEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function buildReferralUpdate(
  body: Record<string, unknown>,
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    if (key === 'status') {
      if (typeof value !== 'string' || !STATUSES.has(value)) return { error: 'invalid status' };
    }
    update[key] = value;
  }
  if (Object.keys(update).length === 0) return { error: 'No updatable fields provided' };
  return { update };
}

export const referralRoutes = new Hono<{ Bindings: WorkerBindings }>();

referralRoutes.get('/', async (c) => {
  const db = getSupabase(c.env);
  let query = db.from('referrals').select(WITH_REFERRER);

  const referrer = c.req.query('referrer');
  if (referrer) query = query.eq('referrer_account_id', referrer);
  const status = c.req.query('status');
  if (status) query = query.eq('status', status);
  const leadId = c.req.query('referred_lead_id');
  if (leadId) query = query.eq('referred_lead_id', leadId);
  const matureBefore = c.req.query('mature_before');
  if (matureBefore) query = query.lte('mature_at', matureBefore);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ referrals: data });
});

referralRoutes.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const code = typeof body.referral_code === 'string' ? body.referral_code.trim() : '';
  const referredLeadId =
    typeof body.referred_lead_id === 'string' ? body.referred_lead_id.trim() : '';
  if (!code) return c.json({ error: 'Missing required field: referral_code' }, 400);
  if (!referredLeadId) return c.json({ error: 'Missing required field: referred_lead_id' }, 400);

  const db = getSupabase(c.env);
  const referrer = await db
    .from('accounts')
    .select('id,email')
    .eq('referral_code', code)
    .maybeSingle();
  if (referrer.error) return c.json({ error: referrer.error.message }, 500);
  if (!referrer.data) return c.json({ error: 'Unknown referral code' }, 404);

  const referredEmail = normaliseEmail(body.referred_email);
  if (referredEmail && referredEmail === normaliseEmail(referrer.data.email)) {
    return c.json({ error: 'self_referral' }, 409);
  }

  const insert = {
    referrer_account_id: referrer.data.id,
    referred_lead_id: referredLeadId,
    ...(referredEmail ? { referred_email: referredEmail } : {}),
    ...(body.referred_shop_id ? { referred_shop_id: body.referred_shop_id } : {}),
  };
  const { data, error } = await db.from('referrals').insert(insert).select(WITH_REFERRER).single();
  if (error) {
    // Stripe retries the same checkout event; the unique lead id makes the retry a no-op.
    if (error.code === '23505') {
      const retry = await db
        .from('referrals')
        .select(WITH_REFERRER)
        .eq('referred_lead_id', referredLeadId)
        .maybeSingle();
      if (retry.data) return c.json({ referral: retry.data });
    }
    return c.json({ error: error.message }, 400);
  }
  return c.json({ referral: data }, 201);
});

referralRoutes.patch('/:id', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const built = buildReferralUpdate(body);
  if ('error' in built) return c.json({ error: built.error }, 400);

  const expected = body.expected_status;
  if (expected !== undefined && (typeof expected !== 'string' || !STATUSES.has(expected))) {
    return c.json({ error: 'invalid expected_status' }, 400);
  }

  const db = getSupabase(c.env);
  let query = db.from('referrals').update(built.update).eq('id', c.req.param('id'));
  // Compare-and-set: two settlement passes racing on the same referral both send
  // expected_status, and Postgres lets exactly one of them match — the loser gets 409.
  if (typeof expected === 'string') query = query.eq('status', expected);

  const { data, error } = await query.select(WITH_REFERRER).single();
  if (error) {
    if (error.code === 'PGRST116') {
      return typeof expected === 'string'
        ? c.json({ error: 'status changed' }, 409)
        : c.json({ error: 'Referral not found' }, 404);
    }
    return c.json({ error: error.message }, 400);
  }
  return c.json({ referral: data });
});
