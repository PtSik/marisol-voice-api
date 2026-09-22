import type { CalendarRouting, ShopRow, WorkerBindings } from '../types';
import { logGcalFailure } from './calendar-alerts';
import { decrypt } from './crypto';
import { parseStaff } from './staff';

// The OAuth blob holds the secret and nothing else — calendar ids live in
// shops.calendar_routing. calendar_id is only still read for blobs written before that split.
interface OAuthCreds {
  type: 'oauth';
  refresh_token: string;
  calendar_id?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

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
  const creds = JSON.parse(await decrypt(encryptedCreds, env.ENCRYPTION_KEY)) as OAuthCreds;
  // The connect flow is the only writer, so anything else is a blob from the retired
  // service-account grant. Refusing here names the fix; passing it on would send an
  // undefined refresh_token to Google and surface as an opaque 400.
  if (creds.type !== 'oauth' || !creds.refresh_token) {
    throw new Error(
      'GCal credentials are not an OAuth grant; the shop must reconnect Google Calendar',
    );
  }
  const token = await fetchOAuthToken(env, creds.refresh_token, signal);
  return { calendar_id: creds.calendar_id ?? 'primary', token };
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
// Booking and availability both refuse on this, with the same sentence: a shop that picked
// Google Calendar but has not finished connecting it has nowhere to write the appointment.
export const CALENDAR_SETUP_INCOMPLETE_RESULT =
  'Google Calendar still needs to be connected. Please finish calendar setup in the Marisol portal before booking an appointment.';

export function calendarSetupIncomplete(shop: ShopRow): boolean {
  return (
    shop.integration === 'google_calendar' &&
    (!shop.integration_credentials_encrypted || !shop.calendar_routing?.write_calendar_id)
  );
}

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

export class GCalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Google accepts a client-supplied event id (base32hex); a UUID with the dashes stripped
// fits. Both the happy-path create and the repair retry use the same id, so a retry can
// never duplicate an event — a collision comes back as 409 instead.
export function deterministicEventId(bookingId: string): string {
  return bookingId.toLowerCase().replace(/-/g, '');
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
  eventId?: string,
): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(eventId ? { id: eventId } : {}),
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
  if (!res.ok) throw new GCalHttpError(res.status, `GCal events.insert failed: ${res.status}`);
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
  // 404/410 mean the event is already gone — for a delete that is success.
  if (res.status === 204 || res.status === 200 || res.status === 404 || res.status === 410) return;
  throw new GCalHttpError(res.status, `GCal events.delete failed: ${res.status}`);
}

export interface GCalEventSnapshot {
  id: string;
  status: string;
  start?: GCalEventTime;
  end?: GCalEventTime;
}

export async function gcalGetEvent(
  calendarId: string,
  token: string,
  eventId: string,
): Promise<GCalEventSnapshot | null> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
  );
  url.search = new URLSearchParams({ fields: 'id,status,start,end' }).toString();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new GCalHttpError(res.status, `GCal events.get failed: ${res.status}`);
  return res.json<GCalEventSnapshot>();
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
  if (!res.ok) throw new GCalHttpError(res.status, `GCal events.patch failed: ${res.status}`);
}

export interface GCalBusy {
  start: number;
  end: number;
  id: string;
  colorId?: string;
  summary?: string;
}

export interface GCalEventTime {
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
    // Without an order Google may truncate the 250-event page arbitrarily; by start time the
    // cut is at least predictable and callers lose the far end of the window, not a random slice.
    orderBy: 'startTime',
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

export interface GCalDeltaEvent {
  id: string;
  status: string;
  start?: GCalEventTime;
  end?: GCalEventTime;
  bookingId?: string;
}

export interface GCalDeltaPage {
  events: GCalDeltaEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// Incremental sync read. Parameters must be identical on every call for a given calendar
// (Google rejects a mismatch with 400): singleEvents=false so recurring masters come back
// as one event, showDeleted=true so deletions appear as status 'cancelled'. timeMin is only
// legal on the first sync (no syncToken) — the token remembers the restriction. An expired
// token surfaces as GCalHttpError(410); the caller restarts from scratch.
export async function gcalListDeltas(
  calendarId: string,
  token: string,
  opts: { syncToken?: string; pageToken?: string; timeMinIso?: string },
): Promise<GCalDeltaPage> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  const params = new URLSearchParams({
    singleEvents: 'false',
    showDeleted: 'true',
    maxResults: '250',
    fields: 'nextPageToken,nextSyncToken,items(id,status,start,end,extendedProperties/private)',
  });
  if (opts.syncToken) params.set('syncToken', opts.syncToken);
  else if (opts.timeMinIso) params.set('timeMin', opts.timeMinIso);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  url.search = params.toString();

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GCalHttpError(res.status, `GCal events.list (sync) failed: ${res.status}`);
  const data = await res.json<{
    nextPageToken?: string;
    nextSyncToken?: string;
    items?: Array<{
      id: string;
      status?: string;
      start?: GCalEventTime;
      end?: GCalEventTime;
      extendedProperties?: { private?: Record<string, string> };
    }>;
  }>();
  return {
    events: (data.items ?? []).map((ev) => ({
      id: ev.id,
      status: ev.status ?? 'confirmed',
      ...(ev.start ? { start: ev.start } : {}),
      ...(ev.end ? { end: ev.end } : {}),
      ...(ev.extendedProperties?.private?.marisol_booking_id
        ? { bookingId: ev.extendedProperties.private.marisol_booking_id }
        : {}),
    })),
    ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
    ...(data.nextSyncToken ? { nextSyncToken: data.nextSyncToken } : {}),
  };
}

export interface StaffBusy {
  // Any missing required read makes availability unknown, not free.
  unavailable?: true;
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
// A controller with an explicit timer rather than AbortSignal.timeout(): the latter's timer
// does not hold the event loop open under Bun, so a hung fetch with nothing else pending is
// never aborted at all. Callers must clear() so a fast read leaves no timer behind.
function deadline(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`GCal read exceeded ${timeoutMs}ms`)),
    Math.max(1, timeoutMs),
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// Read calendars in parallel under one deadline. Keep successful data for diagnostics,
// but flag any missing read so callers cannot offer or confirm unverified availability.
export async function getStaffBusy(
  env: WorkerBindings,
  shop: ShopRow,
  timeMinIso: string,
  timeMaxIso: string,
  options: BusyReadOptions = {},
): Promise<StaffBusy> {
  const encryptedCreds = shop.integration_credentials_encrypted;
  if (shop.integration !== 'google_calendar') return EMPTY_BUSY;
  if (!encryptedCreds) return { ...EMPTY_BUSY, unavailable: true };
  const budget = deadline(options.timeoutMs ?? 1500);
  try {
    return await readStaffBusy(
      env,
      shop,
      encryptedCreds,
      timeMinIso,
      timeMaxIso,
      options,
      budget.signal,
    );
  } finally {
    budget.clear();
  }
}

async function readStaffBusy(
  env: WorkerBindings,
  shop: ShopRow,
  encryptedCreds: string,
  timeMinIso: string,
  timeMaxIso: string,
  options: BusyReadOptions,
  signal: AbortSignal,
): Promise<StaffBusy> {
  const routing = resolveRouting(shop);

  let token: string;
  try {
    const gcal = await getGCalClient(env, encryptedCreds, signal);
    token = gcal.token;
  } catch (err) {
    console.error('[gcal-busy] token unavailable:', err instanceof Error ? err.message : err);
    reportFailure(env, shop, options, { op: 'token', message: errorMessage(err) });
    return { ...EMPTY_BUSY, unavailable: true };
  }

  // One request per distinct calendar: a calendar shared by two staff members is read once,
  // Explicit staff ownership also applies when that calendar is the default write target.
  const staffByCalendar = new Map<string, string[]>();
  for (const [staffId, calendarId] of Object.entries(routing.staff_calendars)) {
    staffByCalendar.set(calendarId, [...(staffByCalendar.get(calendarId) ?? []), staffId]);
  }
  // A staff calendar that also sits in busy_calendar_ids (a legacy mis-config the picker used
  // to allow) stays per-person: reading it as shared would block the whole shop on one
  // person's appointments, the exact failure the picker now prevents.
  const staffCalendarIds = new Set(staffByCalendar.keys());
  const sharedIds = new Set([
    ...(staffCalendarIds.has(routing.write_calendar_id) &&
    parseStaff(shop.staff_json).length > 0 &&
    parseStaff(shop.staff_json).every((m) => routing.staff_calendars[m.id])
      ? []
      : [routing.write_calendar_id]),
    ...routing.busy_calendar_ids.filter((id) => !staffCalendarIds.has(id)),
  ]);
  for (const id of sharedIds) staffByCalendar.delete(id);

  const targets = [
    ...[...sharedIds].map((calendarId) => ({ calendarId, staffIds: [] as string[] })),
    ...[...staffByCalendar].map(([calendarId, staffIds]) => ({ calendarId, staffIds })),
  ];

  const results = await Promise.allSettled(
    targets.map((t) => gcalListBusy(t.calendarId, token, timeMinIso, timeMaxIso, signal)),
  );

  const busy: StaffBusy = { shared: [], perStaff: {} };
  results.forEach((result, i) => {
    const target = targets[i];
    if (!target) return;
    if (result.status === 'rejected') {
      busy.unavailable = true;
      console.error(`[gcal-busy] ${target.calendarId} unavailable:`, errorMessage(result.reason));
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
