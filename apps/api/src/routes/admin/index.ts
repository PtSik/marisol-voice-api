import { Hono } from 'hono';
import {
  canWriteTo,
  gcalListCalendars,
  getGCalClient,
  getStaffBusy,
  resolveRouting,
} from '../../lib/gcal';
import { parseTime } from '../../lib/hours';
import { validServiceCatalog } from '../../lib/service-catalog';
import { parseStaff } from '../../lib/staff';
import { getSupabase } from '../../lib/supabase';
import { adminAuth } from '../../middleware/admin-auth';
import type { CalendarRouting, ShopRow, WorkerBindings } from '../../types';
import { accountRoutes } from './accounts';
import { referralRoutes } from './referrals';

const MUTABLE_FIELDS = new Set([
  'name',
  'twilio_number',
  'escalation_phone',
  'owner_escalation_phone',
  'owner_email',
  'timezone',
  'ai_disclosure_text',
  'hours_json',
  'closures_json',
  'services_json',
  'service_catalog',
  'transfers_enabled',
  'reminders_enabled',
  'staff_json',
  'address',
  'notes',
  'integration',
  'calendar_routing',
  'elevenlabs_agent_id',
  'primary_language',
  'calendar_access_granted_at',
  'is_demo',
  'account_id',
  'status',
]);

// Undefined is valid — the column defaults to 'en', so provisioning may simply omit it.
function isValidPrimaryLanguage(v: unknown): boolean {
  return v === undefined || v === 'en' || v === 'es';
}

// Undefined is valid — the column defaults to false, and every caller except the demo seeder omits
// it. Anything else must be a real boolean: this flag decides whether a shop can hand a caller to a
// human, and set wrongly on a paying client their callers stop reaching them with nothing in the
// logs to say so. A typo'd value earns a clear 400 here rather than a Postgres cast error.
function isValidIsDemo(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean';
}

// Mirrors the CHECK in migration 0015. Undefined is valid — the column defaults to 'trial'. Without
// this a typo'd status lands as a Postgres cast error, and a status the lookups do not know about
// (see CALLABLE_STATUSES) is a shop whose number answers 404 with nothing to say why.
const SHOP_STATUSES = ['trial', 'active', 'cancelled', 'suspended', 'demo'];

function isValidStatus(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && SHOP_STATUSES.includes(v));
}

function isValidHoursValue(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (v.trim().toLowerCase() === 'closed') return true;
  const [open, close] = v.split('-');
  return !!open && !!close && parseTime(open) >= 0 && parseTime(close) >= 0;
}

// Hours/closures are stored as JSON text; accept either a JSON object/array or a
// pre-stringified one, validate the shape, and return the canonical string to store.
function validateHoursJson(raw: unknown): { value: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    return { error: 'hours_json is not valid JSON' };
  }
  if (typeof parsed === 'string') {
    if (!isValidHoursValue(parsed)) return { error: `hours_json: invalid hours "${parsed}"` };
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [day, hrs] of Object.entries(parsed)) {
      if (!isValidHoursValue(hrs)) {
        return { error: `hours_json: invalid hours for "${day}": ${JSON.stringify(hrs)}` };
      }
    }
  } else {
    return { error: 'hours_json must be an object like {"Mon-Fri":"9am-7pm","Sun":"closed"}' };
  }
  return { value: JSON.stringify(parsed) };
}

// Staff accepts both the legacy `["Ana"]` shape and `[{id,name,hours?}]`; either way it is
// canonicalised through parseStaff so every stored member ends up with a stable id.
function validateStaffJson(raw: unknown): { value: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    return { error: 'staff_json is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { error: 'staff_json must be an array' };

  const members = parseStaff(JSON.stringify(parsed));
  if (members.length !== parsed.length) {
    return { error: 'staff_json: every member needs a non-empty name' };
  }
  for (const m of members) {
    for (const [day, hrs] of Object.entries(m.hours ?? {})) {
      if (!isValidHoursValue(hrs)) {
        return { error: `staff_json: invalid hours for ${m.name} on "${day}": ${String(hrs)}` };
      }
    }
  }
  return { value: JSON.stringify(members) };
}

// calendar_routing is a real jsonb column, so it goes to Supabase as an object, not a string.
function validateCalendarRouting(
  raw: unknown,
): { value: CalendarRouting | null } | { error: string } {
  if (raw === null) return { value: null };
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'calendar_routing is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'calendar_routing must be an object' };
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.write_calendar_id !== 'string' || !r.write_calendar_id) {
    return { error: 'calendar_routing.write_calendar_id must be a non-empty string' };
  }
  const staffCalendars: Record<string, string> = {};
  if (r.staff_calendars !== undefined) {
    if (!r.staff_calendars || typeof r.staff_calendars !== 'object') {
      return { error: 'calendar_routing.staff_calendars must be an object' };
    }
    for (const [staffId, calendarId] of Object.entries(r.staff_calendars)) {
      if (typeof calendarId !== 'string' || !calendarId) {
        return { error: `calendar_routing.staff_calendars.${staffId} must be a calendar id` };
      }
      staffCalendars[staffId] = calendarId;
    }
  }
  if (
    r.busy_calendar_ids !== undefined &&
    (!Array.isArray(r.busy_calendar_ids) ||
      r.busy_calendar_ids.some((id) => typeof id !== 'string'))
  ) {
    return { error: 'calendar_routing.busy_calendar_ids must be an array of calendar ids' };
  }
  const attribution = r.attribution as Record<string, unknown> | undefined;
  const mode = attribution?.mode ?? 'off';
  if (mode !== 'off' && mode !== 'color' && mode !== 'title_prefix') {
    return { error: 'calendar_routing.attribution.mode must be off, color or title_prefix' };
  }
  return {
    value: {
      write_calendar_id: r.write_calendar_id,
      staff_calendars: staffCalendars,
      busy_calendar_ids: (r.busy_calendar_ids as string[] | undefined) ?? [],
      attribution: {
        mode,
        ...(attribution?.colors ? { colors: attribution.colors as Record<string, string> } : {}),
      },
    },
  };
}

function validateClosuresJson(raw: unknown): { value: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    return { error: 'closures_json is not valid JSON' };
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
  ) {
    return { error: 'closures_json must be an array of YYYY-MM-DD date strings' };
  }
  return { value: JSON.stringify(parsed) };
}

export const adminRoutes = new Hono<{ Bindings: WorkerBindings }>();

adminRoutes.use('*', adminAuth());

adminRoutes.route('/accounts', accountRoutes);
adminRoutes.route('/referrals', referralRoutes);

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

// Read-only readiness check for prepared shops. This is an admin-only endpoint and
// returns no credentials, event titles, or calendar contents.
adminRoutes.get('/shops/:id/calendar-check', async (c) => {
  const { data, error } = await getSupabase(c.env)
    .from('shops')
    .select('*')
    .eq('id', c.req.param('id'))
    .single();
  if (error || !data) return c.json({ error: 'Shop not found' }, 404);
  const shop = data as ShopRow;
  if (
    shop.integration !== 'google_calendar' ||
    !shop.integration_credentials_encrypted ||
    !shop.calendar_routing
  )
    return c.json({ error: 'Finish connecting and selecting calendars' }, 409);
  try {
    const client = await getGCalClient(
      c.env,
      shop.integration_credentials_encrypted,
      AbortSignal.timeout(5000),
    );
    const calendars = await gcalListCalendars(client.token, AbortSignal.timeout(5000));
    const writable = new Set(calendars.filter(canWriteTo).map((cal) => cal.id));
    const routing = resolveRouting(shop);
    if (
      ![routing.write_calendar_id, ...Object.values(routing.staff_calendars)].every((id) =>
        writable.has(id),
      )
    )
      return c.json({ error: 'A booking calendar is no longer writable' }, 409);
    const busy = await getStaffBusy(
      c.env,
      shop,
      new Date().toISOString(),
      new Date(Date.now() + 7 * 86400000).toISOString(),
      { timeoutMs: 5000, waitUntil: (p) => c.executionCtx.waitUntil(p) },
    );
    if (busy.unavailable) return c.json({ error: 'Could not read every required calendar' }, 503);
    return c.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch {
    return c.json({ error: 'Calendar access could not be verified' }, 503);
  }
});

adminRoutes.get('/shops/:id/activity-summary', async (c) => {
  const shopId = c.req.param('id');
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const db = getSupabase(c.env);
  const [calls, bookings] = await Promise.all([
    db
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shopId)
      .gte('created_at', since),
    db
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shopId)
      .eq('status', 'confirmed')
      .gte('created_at', since),
  ]);
  if (calls.error || bookings.error) return c.json({ error: 'Activity unavailable' }, 503);
  return c.json({ calls_30d: calls.count ?? 0, bookings_30d: bookings.count ?? 0 });
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

  if (body.service_catalog !== undefined && !validServiceCatalog(body.service_catalog))
    return c.json({ error: 'Invalid service catalog' }, 400);
  if (body.transfers_enabled !== undefined && typeof body.transfers_enabled !== 'boolean')
    return c.json({ error: 'Invalid transfer setting' }, 400);
  // Provisioning creates shops through here, so canonicalise staff on the way in — a shop
  // must have stable staff ids from its first second.
  if (body.staff_json !== undefined) {
    const r = validateStaffJson(body.staff_json);
    if ('error' in r) return c.json({ error: r.error }, 400);
    body.staff_json = r.value;
  }

  if (!isValidPrimaryLanguage(body.primary_language)) {
    return c.json({ error: "primary_language must be 'en' or 'es'" }, 400);
  }

  if (!isValidIsDemo(body.is_demo)) {
    return c.json({ error: 'is_demo must be a boolean' }, 400);
  }

  if (!isValidStatus(body.status)) {
    return c.json({ error: `status must be one of: ${SHOP_STATUSES.join(', ')}` }, 400);
  }

  const db = getSupabase(c.env);
  const { data, error } = await db.from('shops').insert(body).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ shop: data }, 201);
});

export function buildShopUpdate(
  body: Record<string, unknown>,
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    if (key === 'hours_json') {
      const r = validateHoursJson(value);
      if ('error' in r) return r;
      update[key] = r.value;
    } else if (key === 'closures_json') {
      const r = validateClosuresJson(value);
      if ('error' in r) return r;
      update[key] = r.value;
    } else if (key === 'staff_json') {
      const r = validateStaffJson(value);
      if ('error' in r) return r;
      update[key] = r.value;
    } else if (key === 'calendar_routing') {
      const r = validateCalendarRouting(value);
      if ('error' in r) return r;
      update[key] = r.value;
    } else if (key === 'calendar_access_granted_at') {
      if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
        return { error: 'invalid calendar access date' };
      update[key] = value;
    } else if (key === 'service_catalog') {
      if (!validServiceCatalog(value))
        return { error: 'service_catalog must contain valid fixed-duration services' };
      update[key] = value;
    } else if (key === 'transfers_enabled') {
      if (typeof value !== 'boolean') return { error: 'transfers_enabled must be a boolean' };
      update[key] = value;
    } else if (key === 'reminders_enabled') {
      if (typeof value !== 'boolean') return { error: 'reminders_enabled must be a boolean' };
      update[key] = value;
    } else if (key === 'primary_language') {
      if (!isValidPrimaryLanguage(value)) return { error: "primary_language must be 'en' or 'es'" };
      update[key] = value;
    } else if (key === 'is_demo') {
      if (!isValidIsDemo(value)) return { error: 'is_demo must be a boolean' };
      update[key] = value;
    } else if (key === 'status') {
      if (!isValidStatus(value))
        return { error: `status must be one of: ${SHOP_STATUSES.join(', ')}` };
      update[key] = value;
    } else {
      update[key] = value;
    }
  }

  // Disconnecting the integration must drop the token and the mapping together — a routing
  // that outlives the token is dead config pointing at calendars we can no longer reach.
  if (update.integration === 'none') {
    update.integration_credentials_encrypted = null;
    update.calendar_routing = null;
  }

  if (Object.keys(update).length === 0) return { error: 'No updatable fields provided' };
  return { update };
}

adminRoutes.patch('/shops/:id', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const built = buildShopUpdate(body);
  if ('error' in built) return c.json({ error: built.error }, 400);
  const update = built.update;

  const db = getSupabase(c.env);
  const { data, error } = await db
    .from('shops')
    .update(update)
    .eq('id', c.req.param('id'))
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: 'Shop not found' }, 404);
    return c.json({ error: error.message }, 400);
  }
  return c.json({ shop: data });
});
