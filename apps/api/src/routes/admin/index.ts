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
  'service_catalog',
  'transfers_enabled',
  'reminders_enabled',
  'sms_enabled',
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

// The columns a create may never carry. `id` and `created_at` belong to the database, and the
// calendar token is written only by the OAuth connect flow — a payload that plants one would give a
// shop access nobody granted. Named apart from the generic unknown-field message so it is loud.
const CREATE_FORBIDDEN_FIELDS = new Set(['id', 'created_at', 'integration_credentials_encrypted']);

const REQUIRED_CREATE_FIELDS = [
  'name',
  'twilio_number',
  'escalation_phone',
  'owner_escalation_phone',
  'owner_email',
];

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

// Mirrors the CHECK in migration 0021. Undefined is valid — the column defaults to 'suspended'.
// Without this a typo'd status lands as a Postgres cast error, and a status the lookups do not know
// about (see CALLABLE_STATUSES) is a shop whose number answers 404 with nothing to say why.
const SHOP_STATUSES = ['active', 'cancelled', 'suspended'];

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
  if (parsed.some((entry) => typeof entry === 'string')) {
    return { error: 'staff_json: each member is an object with a name, not a bare string' };
  }

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

// Create and update accept the same columns and check each one the same way; they differ only in
// what a missing field means. One dispatch keeps a new column from being validated on one path and
// waved through on the other — which is how create ended up storing hours PATCH would refuse.
function validateShopField(key: string, value: unknown): { value: unknown } | { error: string } {
  switch (key) {
    case 'hours_json':
      return validateHoursJson(value);
    case 'closures_json':
      return validateClosuresJson(value);
    case 'staff_json':
      return validateStaffJson(value);
    case 'calendar_routing':
      return validateCalendarRouting(value);
    case 'calendar_access_granted_at':
      if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
        return { error: 'invalid calendar access date' };
      return { value };
    case 'service_catalog':
      if (!validServiceCatalog(value))
        return { error: 'service_catalog must contain valid services' };
      return { value };
    case 'transfers_enabled':
    case 'reminders_enabled':
    case 'sms_enabled':
      if (typeof value !== 'boolean') return { error: `${key} must be a boolean` };
      return { value };
    case 'primary_language':
      if (!isValidPrimaryLanguage(value)) return { error: "primary_language must be 'en' or 'es'" };
      return { value };
    case 'is_demo':
      if (!isValidIsDemo(value)) return { error: 'is_demo must be a boolean' };
      return { value };
    case 'status':
      if (!isValidStatus(value))
        return { error: `status must be one of: ${SHOP_STATUSES.join(', ')}` };
      return { value };
    default:
      return { value };
  }
}

export const adminRoutes = new Hono<{ Bindings: WorkerBindings }>();

adminRoutes.use('*', adminAuth);

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

// Provisioning creates shops through here, so every value is canonicalised on the way in — a shop
// must have stable staff ids and storable hours from its first second.
export function buildShopCreate(
  body: Record<string, unknown>,
): { row: Record<string, unknown> } | { error: string } {
  for (const field of REQUIRED_CREATE_FIELDS) {
    if (!body[field]) return { error: `Missing required field: ${field}` };
  }

  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (CREATE_FORBIDDEN_FIELDS.has(key)) return { error: `${key} cannot be set on create` };
    // PATCH drops an unknown key silently; create names it. This is the one call that decides what
    // a shop row contains, and a field the worker never reads is a setting the owner believes they
    // configured — better a 400 the provisioning run surfaces than a salon missing it in the dark.
    if (!MUTABLE_FIELDS.has(key)) return { error: `Unknown field: ${key}` };
    const r = validateShopField(key, value);
    if ('error' in r) return r;
    row[key] = r.value;
  }

  return { row };
}

adminRoutes.post('/shops', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const built = buildShopCreate(body);
  if ('error' in built) return c.json({ error: built.error }, 400);

  const db = getSupabase(c.env);
  const { data, error } = await db.from('shops').insert(built.row).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ shop: data }, 201);
});

export function buildShopUpdate(
  body: Record<string, unknown>,
): { update: Record<string, unknown> } | { error: string } {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    const r = validateShopField(key, value);
    if ('error' in r) return r;
    update[key] = r.value;
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
