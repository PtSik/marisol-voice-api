import { Hono } from 'hono';
import { getSupabase } from '../../lib/supabase';
import { adminAuth } from '../../middleware/admin-auth';
import type { WorkerBindings } from '../../types';

export const adminRoutes = new Hono<{ Bindings: WorkerBindings }>();

adminRoutes.use('*', adminAuth());

adminRoutes.get('/shops', async (c) => {
  const db = getSupabase(c.env);
  const { data, error } = await db
    .from('shops')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ shops: data });
});

adminRoutes.get('/shops/:id', async (c) => {
  const db = getSupabase(c.env);
  const { data, error } = await db.from('shops').select('*').eq('id', c.req.param('id')).single();
  if (error || !data) return c.json({ error: 'Shop not found' }, 404);
  return c.json({ shop: data });
});

adminRoutes.post('/shops', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const required = [
    'name',
    'twilio_number',
    'escalation_phone',
    'owner_escalation_phone',
    'owner_email',
  ];
  for (const field of required) {
    if (!body[field]) return c.json({ error: `Missing required field: ${field}` }, 400);
  }

  const db = getSupabase(c.env);
  const { data, error } = await db.from('shops').insert(body).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ shop: data }, 201);
});
