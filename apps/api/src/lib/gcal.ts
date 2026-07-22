import type { CalendarRouting, ShopRow, WorkerBindings } from '../types';
import { logGcalFailure } from './calendar-alerts';
import { decrypt } from './crypto';

interface GCalCreds {
  client_email: string;
  private_key: string;
  calendar_id: string;
}

// The OAuth blob holds the secret and nothing else — calendar ids live in
// shops.calendar_routing. calendar_id is only still read for blobs written before that split.
interface OAuthCreds {
  type: 'oauth';
  refresh_token: string;
  calendar_id?: string;
}

type StoredCreds = GCalCreds | OAuthCreds;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function fetchToken(creds: GCalCreds): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${claims}`;

  const pem = creds.private_key.replace(/\\n/g, '\n');
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`GCal token exchange failed: ${await res.text()}`);
  const { access_token } = await res.json<{ access_token: string }>();
  return access_token;
}

async function getToken(creds: GCalCreds): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(creds.client_email);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchToken(creds);
  tokenCache.set(creds.client_email, { token, expiresAt: now + 3500 });
  return token;
}

async function fetchOAuthToken(
  env: WorkerBindings,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    }),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`GCal OAuth refresh failed: ${await res.text()}`);
  const { access_token, expires_in } = await res.json<{
    access_token: string;
    expires_in?: number;
  }>();
  tokenCache.set(refreshToken, {
    token: access_token,
    expiresAt: now + (expires_in ?? 3600) - 100,
  });
  return access_token;
}

export async function getGCalClient(
  env: WorkerBindings,
  encryptedCreds: string,
  signal?: AbortSignal,
): Promise<{ calendar_id: string; token: string }> {
  const creds = JSON.parse(await decrypt(encryptedCreds, env.ENCRYPTION_KEY)) as StoredCreds;
  if ('type' in creds) {
    const token = await fetchOAuthToken(env, creds.refresh_token, signal);
    return { calendar_id: creds.calendar_id ?? 'primary', token };
  }
  const token = await getToken(creds);
  return { calendar_id: creds.calendar_id, token };
}

const DEFAULT_ROUTING: CalendarRouting = {
  write_calendar_id: 'primary',
  staff_calendars: {},
  busy_calendar_ids: [],
  attribution: { mode: 'off' },
};

// A shop that never used the picker (calendar_routing NULL) keeps today's behaviour: one
// calendar, every foreign event blocking the whole shop.
export function resolveRouting(shop: ShopRow): CalendarRouting {
  const r = shop.calendar_routing;
  if (!r) return DEFAULT_ROUTING;
  return {
    write_calendar_id: r.write_calendar_id || 'primary',
    staff_calendars: r.staff_calendars ?? {},
    busy_calendar_ids: r.busy_calendar_ids ?? [],
    attribution: r.attribution ?? { mode: 'off' },
  };
}

// Bookings land in the staff member's own calendar when the shop mapped one; everything
// else — including a name we couldn't resolve — goes to the main calendar.
export function writeCalendarFor(shop: ShopRow, staffId?: string): string {
  const routing = resolveRouting(shop);
  return (staffId && routing.staff_calendars[staffId]) || routing.write_calendar_id;
}

export interface GCalCalendar {
  id: string;
  summary: string;
  accessRole: string;
  primary: boolean;
}

const WRITABLE_ROLES = new Set(['owner', 'writer']);

export function canWriteTo(calendar: GCalCalendar): boolean {
  return WRITABLE_ROLES.has(calendar.accessRole);
}

export async function gcalListCalendars(
  token: string,
  signal?: AbortSignal,
): Promise<GCalCalendar[]> {
  const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  url.search = new URLSearchParams({
    minAccessRole: 'freeBusyReader',
    maxResults: '250',
    showHidden: 'false',
    fields: 'items(id,summary,summaryOverride,accessRole,primary)',
  }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`GCal calendarList.list failed: ${res.status}`);
  const data = await res.json<{
    items?: Array<{
      id: string;
      summary?: string;
      summaryOverride?: string;
      accessRole?: string;
      primary?: boolean;
    }>;
  }>();
  return (data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride ?? c.summary ?? c.id,
    accessRole: c.accessRole ?? 'reader',
    primary: c.primary === true,
  }));
}

export async function gcalCreateEvent(
  calendarId: string,
  token: string,
  summary: string,
  description: string,
  startIso: string,
  endIso: string,
  timeZone: string,
  bookingId?: string,
): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone },
        status: 'confirmed',
        ...(bookingId
          ? { extendedProperties: { private: { marisol_booking_id: bookingId } } }
          : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`GCal events.insert failed: ${res.status}`);
  const { id } = await res.json<{ id: string }>();
  return id;
}

export async function gcalDeleteEvent(
  calendarId: string,
  token: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 204 || res.status === 200 || res.status === 410) return;
  throw new Error(`GCal events.delete failed: ${res.status}`);
}

export async function gcalPatchEvent(
  calendarId: string,
  token: string,
  eventId: string,
  startIso: string,
  endIso: string,
  timeZone: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone },
      }),
    },
  );
  if (!res.ok) throw new Error(`GCal events.patch failed: ${res.status}`);
}

export interface GCalBusy {
  start: number;
  end: number;
  id: string;
  colorId?: string;
  summary?: string;
}

interface GCalEventTime {
  dateTime?: string;
  date?: string;
}

export async function gcalListBusy(
  calendarId: string,
  token: string,
  timeMinIso: string,
  timeMaxIso: string,
  signal?: AbortSignal,
): Promise<GCalBusy[]> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.search = new URLSearchParams({
    singleEvents: 'true',
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    maxResults: '250',
    fields: 'items(id,start,end,status,transparency,colorId,summary)',
  }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`GCal events.list failed: ${res.status}`);
  const data = await res.json<{
    items?: Array<{
      id: string;
      status?: string;
      transparency?: string;
      colorId?: string;
      summary?: string;
      start?: GCalEventTime;
      end?: GCalEventTime;
    }>;
  }>();
  const busy: GCalBusy[] = [];
  for (const ev of data.items ?? []) {
    if (ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
    const s = ev.start?.dateTime ?? ev.start?.date;
    const e = ev.end?.dateTime ?? ev.end?.date;
    if (!s || !e) continue;
    busy.push({
      start: new Date(s).getTime(),
      end: new Date(e).getTime(),
      id: ev.id,
      ...(ev.colorId ? { colorId: ev.colorId } : {}),
      ...(ev.summary ? { summary: ev.summary } : {}),
    });
  }
  return busy;
}

export interface StaffBusy {
  // Blocks the whole shop: the main calendar plus any calendar marked busy-only.
  shared: GCalBusy[];
  // Blocks one person, keyed by staff.id.
  perStaff: Record<string, GCalBusy[]>;
}

export interface BusyReadOptions {
  timeoutMs?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const EMPTY_BUSY: StaffBusy = { shared: [], perStaff: {} };

// One deadline covers the whole read, refresh-token exchange included — an AbortSignal that
// only wraps events.list leaves the token fetch hanging outside the budget on a cold cache.
function remainingSignal(deadlineAt: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
}

// Foreign-event busy for a shop's calendars, one events.list per calendar in parallel.
// Fail-open at two levels: a calendar that errors or times out drops out of the result while
// the rest stay (allSettled, not all — one slow staff calendar must not blind us to the main
// one), and a failed token exchange yields empty busy so the agent keeps answering from
// Supabase alone rather than going silent on the line.
export async function getStaffBusy(
  env: WorkerBindings,
  shop: ShopRow,
  timeMinIso: string,
  timeMaxIso: string,
  options: BusyReadOptions = {},
): Promise<StaffBusy> {
  if (shop.integration !== 'google_calendar' || !shop.integration_credentials_encrypted) {
    return EMPTY_BUSY;
  }
  const deadlineAt = Date.now() + (options.timeoutMs ?? 1500);
  const routing = resolveRouting(shop);

  let token: string;
  try {
    const gcal = await getGCalClient(
      env,
      shop.integration_credentials_encrypted,
      remainingSignal(deadlineAt),
    );
    token = gcal.token;
  } catch (err) {
    console.error('[gcal-busy] token fail-open:', err instanceof Error ? err.message : err);
    reportFailure(env, shop, options, { op: 'token', message: errorMessage(err) });
    return EMPTY_BUSY;
  }

  // One request per distinct calendar: a calendar shared by two staff members is read once,
  // and a staff calendar that is also the write calendar counts as shared for everybody.
  const staffByCalendar = new Map<string, string[]>();
  for (const [staffId, calendarId] of Object.entries(routing.staff_calendars)) {
    if (calendarId === routing.write_calendar_id) continue;
    staffByCalendar.set(calendarId, [...(staffByCalendar.get(calendarId) ?? []), staffId]);
  }
  const sharedIds = new Set([routing.write_calendar_id, ...routing.busy_calendar_ids]);
  for (const id of sharedIds) staffByCalendar.delete(id);

  const targets = [
    ...[...sharedIds].map((calendarId) => ({ calendarId, staffIds: [] as string[] })),
    ...[...staffByCalendar].map(([calendarId, staffIds]) => ({ calendarId, staffIds })),
  ];

  const results = await Promise.allSettled(
    targets.map((t) =>
      gcalListBusy(t.calendarId, token, timeMinIso, timeMaxIso, remainingSignal(deadlineAt)),
    ),
  );

  const busy: StaffBusy = { shared: [], perStaff: {} };
  results.forEach((result, i) => {
    const target = targets[i];
    if (!target) return;
    if (result.status === 'rejected') {
      console.error(`[gcal-busy] ${target.calendarId} fail-open:`, errorMessage(result.reason));
      reportFailure(env, shop, options, {
        op: 'busy',
        calendar_id: target.calendarId,
        message: errorMessage(result.reason),
      });
      return;
    }
    if (target.staffIds.length === 0) {
      busy.shared.push(...result.value);
      return;
    }
    for (const staffId of target.staffIds) {
      busy.perStaff[staffId] = [...(busy.perStaff[staffId] ?? []), ...result.value];
    }
  });
  return busy;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportFailure(
  env: WorkerBindings,
  shop: ShopRow,
  options: BusyReadOptions,
  failure: { op: 'busy' | 'token'; calendar_id?: string; message: string },
): void {
  const logged = logGcalFailure(env, shop.id, failure);
  options.waitUntil?.(logged);
}
