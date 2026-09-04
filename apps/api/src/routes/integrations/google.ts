import { Hono } from 'hono';
import { type ColorUsage, summarizeEventColors } from '../../lib/attribution';
import { encrypt, hmacSHA256, timingSafeEqual } from '../../lib/crypto';
import {
  type GCalBusy,
  type GCalCalendar,
  canWriteTo,
  gcalListBusy,
  gcalListCalendars,
  getGCalClient,
  resolveRouting,
} from '../../lib/gcal';
import { type StaffMember, parseStaff } from '../../lib/staff';
import { getSupabase } from '../../lib/supabase';
import type { CalendarAttribution, CalendarRouting, ShopRow, WorkerBindings } from '../../types';

// calendar.freebusy is requested but unused: it is granular and harmless, and having it on
// the consent screen means a later switch to batched free/busy reads needs no re-consent.
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
].join(' ');

// Every extra busy calendar is one more API call on every availability question, so the
// picker caps how many a shop can tick.
const MAX_BUSY_CALENDARS = 20;

// Google's fixed event palette, by colorId: [id, name, hex].
const GOOGLE_EVENT_COLORS: Array<[string, string, string]> = [
  ['1', 'Lavender', '#7986cb'],
  ['2', 'Sage', '#33b679'],
  ['3', 'Grape', '#8e24aa'],
  ['4', 'Flamingo', '#e67c73'],
  ['5', 'Banana', '#f6bf26'],
  ['6', 'Tangerine', '#f4511e'],
  ['7', 'Peacock', '#039be5'],
  ['8', 'Graphite', '#616161'],
  ['9', 'Blueberry', '#3f51b5'],
  ['10', 'Basil', '#0b8043'],
  ['11', 'Tomato', '#d50000'],
];
const COLOR_BY_ID = new Map(GOOGLE_EVENT_COLORS.map(([id, name, hex]) => [id, { name, hex }]));

// A read that only feeds the picker's hint must not stall the page — well under the render.
const COLOR_SCAN_TIMEOUT_MS = 4000;
const COLOR_SCAN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

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

function page(body: string, form = false): string {
  const formStyles = form
    ? '.card{max-width:560px;text-align:left}h2{font-size:15px;margin:26px 0 10px}label{display:block;font-size:14px;margin:0 0 6px;color:#241B14}select{width:100%;padding:9px 10px;border:1px solid #E2D8CB;border-radius:8px;background:#fff;font-size:14px;margin:0 0 14px}fieldset{border:0;padding:0;margin:0}.check{display:flex;gap:8px;align-items:center;margin:0 0 8px;font-size:14px}.check input{margin:0}.check.is-locked{opacity:.55}.check .reason{color:#6F6457;font-size:12px}button{width:100%;padding:12px;border:0;border-radius:10px;background:#241B14;color:#fff;font-size:15px;cursor:pointer;margin-top:22px}.note{font-size:13px;margin:14px 0 0}.err{color:#A3341F;font-size:14px;margin:0 0 14px}.colorrow{display:flex;gap:8px;align-items:center;margin:0 0 12px}.swatch{width:16px;height:16px;border-radius:4px;flex:none;border:1px solid rgba(0,0,0,.15)}.cinfo{flex:1;font-size:13px;color:#6F6457}.colorrow select{width:auto;margin:0;flex:none}details.more summary{font-size:13px;color:#6F6457;cursor:pointer;margin:0 0 10px}'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marisol · Calendar</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#FBF6EF;color:#241B14;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{background:#fff;border-radius:16px;padding:32px 28px;max-width:440px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 10px}p{color:#6F6457;line-height:1.55;margin:0}${formStyles}</style></head><body><div class="card">${body}</div></body></html>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  // The blob carries the secret only — calendar ids live in shops.calendar_routing, written
  // by the picker alone, so these two writers can never race over one field.
  const creds = JSON.stringify({ type: 'oauth', refresh_token: tokens.refresh_token });
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

  return c.redirect(
    `/integrations/google/select?shop_id=${encodeURIComponent(shopId)}&sig=${encodeURIComponent(sig)}`,
    302,
  );
});

// Everything below serves the calendar picker: which calendar we write to, which calendar
// belongs to which staff member, and which extra calendars only count as busy.
async function loadShop(env: WorkerBindings, shopId: string): Promise<ShopRow | null> {
  const { data } = await getSupabase(env).from('shops').select('*').eq('id', shopId).single();
  return (data as ShopRow | null) ?? null;
}

function calendarOptions(
  calendars: GCalCalendar[],
  selected: string | undefined,
  placeholder?: string,
): string {
  const options = calendars.map(
    (cal) =>
      `<option value="${esc(cal.id)}"${cal.id === selected ? ' selected' : ''}>${esc(cal.summary)}</option>`,
  );
  if (placeholder) {
    options.unshift(`<option value=""${selected ? '' : ' selected'}>${esc(placeholder)}</option>`);
  }
  return options.join('');
}

function truncate(value: string, max = 28): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function colorRow(
  colorId: string,
  usage: ColorUsage | undefined,
  staff: StaffMember[],
  routing: CalendarRouting,
): string {
  const meta = COLOR_BY_ID.get(colorId) ?? { name: `Colour ${colorId}`, hex: '#ccc' };
  // A mapping the client already saved wins over the hint — they chose it on purpose.
  const savedStaff = routing.attribution.colors?.[colorId];
  const selected = savedStaff ?? usage?.hintStaffId;
  const options = staff
    .map(
      (m) =>
        `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`,
    )
    .join('');
  const count = usage ? ` · ${usage.count} ${usage.count === 1 ? 'entry' : 'entries'}` : '';
  const provenance =
    !savedStaff && usage?.hintStaffId && usage.hintTitle
      ? ` · suggested from “${esc(truncate(usage.hintTitle))}”`
      : '';
  return `<div class="colorrow"><span class="swatch" style="background:${meta.hex}"></span><span class="cinfo">${esc(meta.name)}${count}${provenance}</span><select aria-label="Who uses ${esc(meta.name)}?" name="colorstaff_${esc(colorId)}"><option value=""${selected ? '' : ' selected'}>Nobody</option>${options}</select></div>`;
}

// Every colour keeps a field, always: the form is the whole payload on save, so rendering only
// the colours we happened to observe would drop a saved mapping the moment its owner has a quiet
// month. Observed colours lead with counts and hints; the rest wait behind a disclosure.
export function colorMapMarkup(
  staff: StaffMember[],
  routing: CalendarRouting,
  colorUsage: ColorUsage[] | undefined,
): string {
  const usageById = new Map((colorUsage ?? []).map((u) => [u.colorId, u]));
  const unused = GOOGLE_EVENT_COLORS.map(([id]) => id).filter((id) => !usageById.has(id));
  const used = [...usageById.keys()]
    .map((id) => colorRow(id, usageById.get(id), staff, routing))
    .join('');
  const rest = unused.map((id) => colorRow(id, undefined, staff, routing)).join('');
  if (!used) return rest;
  return `${used}<details class="more"><summary>Show the colours you haven't used yet</summary>${rest}</details>`;
}

const BUSY_SYNC_SCRIPT = `<script>(function(){
var write=document.getElementById('write_calendar');
var staff=[].slice.call(document.querySelectorAll('select.js-staff'));
var rows=[].slice.call(document.querySelectorAll('[data-busy-cal]'));
function apply(){
var occ={};
if(write&&write.value){occ[write.value]='Booking target — always read';}
staff.forEach(function(s){if(s.value&&!occ[s.value]){occ[s.value]='Already read for '+(s.getAttribute('data-staff-name')||'a staff member');}});
rows.forEach(function(row){
var box=row.querySelector('input[type=checkbox]');var reason=row.querySelector('.reason');
var why=occ[row.getAttribute('data-busy-cal')];
if(why){box.checked=false;box.disabled=true;row.classList.add('is-locked');if(reason){reason.textContent=why;}}
else{box.disabled=false;row.classList.remove('is-locked');if(reason){reason.textContent='';}}
});
}
if(write){write.addEventListener('change',apply);}
staff.forEach(function(s){s.addEventListener('change',apply);});
apply();
})();</script>`;

function selectForm(input: {
  shopId: string;
  sig: string;
  calendars: GCalCalendar[];
  staff: StaffMember[];
  routing: CalendarRouting;
  colorUsage?: ColorUsage[] | undefined;
  error?: string;
}): string {
  const { shopId, sig, calendars, staff, routing, colorUsage } = input;
  const writable = calendars.filter(canWriteTo);
  // A shop that hasn't used the picker carries the 'primary' alias, which matches no id in
  // the list — fall back to the account's primary calendar so nothing looks pre-picked wrong.
  const writeSelected = writable.some((cal) => cal.id === routing.write_calendar_id)
    ? routing.write_calendar_id
    : (writable.find((cal) => cal.primary)?.id ?? writable[0]?.id);
  const staffRows = staff
    .map(
      (m) =>
        `<label for="staff_${esc(m.id)}">${esc(m.name)}</label><select class="js-staff" data-staff-name="${esc(m.name)}" id="staff_${esc(m.id)}" name="staff_${esc(m.id)}">${calendarOptions(
          writable,
          routing.staff_calendars[m.id],
          'Main calendar',
        )}</select>`,
    )
    .join('');
  const staffCalendarName = new Map<string, string>();
  for (const m of staff) {
    const calId = routing.staff_calendars[m.id];
    if (calId && !staffCalendarName.has(calId)) staffCalendarName.set(calId, m.name);
  }
  // The busy list must never let a booking target or a staff-owned calendar be ticked: doing so
  // moves that calendar into the shared pool, where one person's appointments block the whole
  // shop. The inline script re-runs this as the client changes staff mapping, without a save.
  const busyRows = calendars
    .map((cal, i) => {
      const lockedByWrite = cal.id === writeSelected;
      const lockedByStaff = !lockedByWrite && staffCalendarName.has(cal.id);
      const locked = lockedByWrite || lockedByStaff;
      const reason = lockedByWrite
        ? 'Booking target — always read'
        : lockedByStaff
          ? `Already read for ${esc(staffCalendarName.get(cal.id) as string)}`
          : '';
      const checked = !locked && routing.busy_calendar_ids.includes(cal.id);
      return `<div class="check${locked ? ' is-locked' : ''}" data-busy-cal="${esc(cal.id)}"><input type="checkbox" id="busy_${i}" name="busy" value="${esc(cal.id)}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}><label for="busy_${i}">${esc(cal.summary)}</label><span class="reason">${reason}</span></div>`;
    })
    .join('');
  const mode = routing.attribution.mode;
  const colorRows = colorMapMarkup(staff, routing, colorUsage);

  return `<h1>Choose your calendars</h1>
${input.error ? `<p class="err">${esc(input.error)}</p>` : ''}
<form method="post" action="/integrations/google/select">
<input type="hidden" name="shop_id" value="${esc(shopId)}">
<input type="hidden" name="sig" value="${esc(sig)}">
<h2>Where should bookings be saved?</h2>
<label for="write_calendar">Main calendar</label>
<select id="write_calendar" name="write_calendar">${calendarOptions(writable, writeSelected)}</select>
${staff.length > 0 ? `<h2>Calendar per staff member</h2><p class="note">Optional — leave on “Main calendar” if everyone shares one.</p>${staffRows}` : ''}
<h2>Also check these for busy times</h2>
<p class="note">We only read these — nothing is ever written there. Pick up to ${MAX_BUSY_CALENDARS}.</p>
<fieldset>${busyRows}</fieldset>
${
  staff.length > 0
    ? `<h2>Appointments you enter yourself</h2>
<p class="note">If we can tell who an entry belongs to, it only blocks that person. Otherwise it blocks everyone — the safe default.</p>
<fieldset>
<div class="check"><input type="radio" id="attr_off" name="attribution_mode" value="off"${mode === 'off' ? ' checked' : ''}><label for="attr_off">Blocks everyone (default)</label></div>
<div class="check"><input type="radio" id="attr_color" name="attribution_mode" value="color"${mode === 'color' ? ' checked' : ''}><label for="attr_color">I colour-code entries by person</label></div>
<div class="check"><input type="radio" id="attr_title" name="attribution_mode" value="title_prefix"${mode === 'title_prefix' ? ' checked' : ''}><label for="attr_title">I start the title with the person's name (“Ana — haircut”)</label></div>
</fieldset>
<p class="note">If you colour-code, tell us whose colour is whose:</p>
${colorRows}`
    : ''
}
<p class="note">Your staff will see these appointments only if you've shared that calendar with them in Google Calendar. Bookings are always saved here for you either way.</p>
<button type="submit">Save and finish</button>
</form>${BUSY_SYNC_SCRIPT}`;
}

async function calendarContext(
  c: { env: WorkerBindings },
  shopId: string,
): Promise<
  | { shop: ShopRow; calendars: GCalCalendar[]; token: string }
  | { error: keyof typeof CONTEXT_ERROR_PAGES; status: 400 | 500 | 502 }
> {
  const shop = await loadShop(c.env, shopId);
  if (!shop || !shop.integration_credentials_encrypted) {
    return { error: 'no_connection', status: 400 };
  }
  try {
    const gcal = await getGCalClient(c.env, shop.integration_credentials_encrypted);
    return { shop, calendars: await gcalListCalendars(gcal.token), token: gcal.token };
  } catch (err) {
    console.error('[gcal-select] calendar list failed:', err instanceof Error ? err.message : err);
    return { error: 'list_failed', status: 502 };
  }
}

// Only colour-coding shops pay for this read: mode 'off'/'title_prefix' never maps colours, so
// scanning them would be a wasted API call. Scans exactly the calendars attribution later splits
// — the write target plus the shared busy ones — because a colour used only on a shared calendar
// still needs its hint. A failed read costs nothing but the count next to that colour.
async function scanEventColors(
  token: string,
  routing: CalendarRouting,
  staff: StaffMember[],
): Promise<ColorUsage[] | undefined> {
  if (routing.attribution.mode !== 'color' || staff.length === 0) return undefined;
  const staffCalendars = new Set(Object.values(routing.staff_calendars));
  const calendarIds = [
    ...new Set([
      routing.write_calendar_id || 'primary',
      ...routing.busy_calendar_ids.filter((id) => !staffCalendars.has(id)),
    ]),
  ];
  const now = Date.now();
  const timeMin = new Date(now - COLOR_SCAN_WINDOW_MS).toISOString();
  const timeMax = new Date(now + COLOR_SCAN_WINDOW_MS).toISOString();
  const signal = AbortSignal.timeout(COLOR_SCAN_TIMEOUT_MS);
  const reads = await Promise.allSettled(
    calendarIds.map((id) => gcalListBusy(id, token, timeMin, timeMax, signal)),
  );
  const events: GCalBusy[] = [];
  for (const [i, read] of reads.entries()) {
    if (read.status === 'fulfilled') events.push(...read.value);
    else console.error(`[gcal-select] colour scan failed for ${calendarIds[i]}:`, read.reason);
  }
  const usage = summarizeEventColors(events, staff);
  return usage.length > 0 ? usage : undefined;
}

const CONTEXT_ERROR_PAGES = {
  no_connection:
    "<h1>Your calendar isn't connected yet</h1><p>Please start from the button in your welcome email.</p>",
  list_failed:
    "<h1>We couldn't load your calendars</h1><p>Please try the link again in a moment, or reply to your welcome email and we'll finish it for you.</p>",
  no_writable:
    "<h1>No calendar we can write to</h1><p>The Google account you connected can only view its calendars. Please reply to your welcome email and we'll sort it out with you.</p>",
};

googleIntegrationRoutes.get('/select', async (c) => {
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

  const ctx = await calendarContext(c, shopId);
  if ('error' in ctx) return c.html(page(CONTEXT_ERROR_PAGES[ctx.error]), ctx.status);
  if (!ctx.calendars.some(canWriteTo)) return c.html(page(CONTEXT_ERROR_PAGES.no_writable), 400);

  const staff = parseStaff(ctx.shop.staff_json);
  const routing = resolveRouting(ctx.shop);
  const colorUsage = await scanEventColors(ctx.token, routing, staff);

  return c.html(
    page(selectForm({ shopId, sig, calendars: ctx.calendars, staff, routing, colorUsage }), true),
    200,
  );
});

googleIntegrationRoutes.post('/select', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const shopId = typeof body.shop_id === 'string' ? body.shop_id : '';
  const sig = typeof body.sig === 'string' ? body.sig : '';
  if (!shopId || !sig || !(await validSig(c.env, shopId, sig))) {
    return c.html(
      page(
        "<h1>This link isn't valid</h1><p>Please use the button from your welcome email, or reply to it and we'll help.</p>",
      ),
      400,
    );
  }

  const ctx = await calendarContext(c, shopId);
  if ('error' in ctx) return c.html(page(CONTEXT_ERROR_PAGES[ctx.error]), ctx.status);

  const { shop, calendars } = ctx;
  const staff = parseStaff(shop.staff_json);
  const current = resolveRouting(shop);
  const writableIds = new Set(calendars.filter(canWriteTo).map((cal) => cal.id));
  const knownIds = new Set(calendars.map((cal) => cal.id));
  // Scanned only when we actually re-render: a successful save must not pay for a hint nobody sees.
  const rerender = async (error: string) =>
    c.html(
      page(
        selectForm({
          shopId,
          sig,
          calendars,
          staff,
          routing: current,
          colorUsage: await scanEventColors(ctx.token, current, staff),
          error,
        }),
        true,
      ),
      400,
    );

  const writeCalendarId = typeof body.write_calendar === 'string' ? body.write_calendar : '';
  // A read-only calendar as the write target would fail silently: the booking and its SMS
  // still succeed (the event write runs in waitUntil) and the calendar stays empty.
  if (!writableIds.has(writeCalendarId)) {
    return await rerender('Please pick a main calendar you can edit.');
  }

  const staffCalendars: Record<string, string> = {};
  for (const member of staff) {
    const picked = body[`staff_${member.id}`];
    const id = typeof picked === 'string' ? picked : '';
    if (!id) continue;
    if (!writableIds.has(id))
      return await rerender(`Please pick a calendar you can edit for ${member.name}.`);
    staffCalendars[member.id] = id;
  }

  const busyRaw = body.busy;
  const alreadyRead = new Set([writeCalendarId, ...Object.values(staffCalendars)]);
  const busyCalendarIds = [
    ...new Set(
      (Array.isArray(busyRaw) ? busyRaw : busyRaw ? [busyRaw] : [])
        .filter((v): v is string => typeof v === 'string')
        .filter((id) => knownIds.has(id) && !alreadyRead.has(id)),
    ),
  ];
  if (busyCalendarIds.length > MAX_BUSY_CALENDARS) {
    return await rerender(
      `Please pick at most ${MAX_BUSY_CALENDARS} calendars to check for busy times.`,
    );
  }

  // A wrong attribution frees a slot rather than holding it, so anything we don't understand
  // falls back to "blocks everyone".
  const rawMode = body.attribution_mode;
  const mode: CalendarAttribution['mode'] =
    rawMode === 'color' || rawMode === 'title_prefix' ? rawMode : 'off';
  const colors: Record<string, string> = {};
  if (mode === 'color') {
    const staffIds = new Set(staff.map((m) => m.id));
    for (const [colorId] of GOOGLE_EVENT_COLORS) {
      const picked = body[`colorstaff_${colorId}`];
      if (typeof picked === 'string' && staffIds.has(picked)) colors[colorId] = picked;
    }
  }

  const routing: CalendarRouting = {
    write_calendar_id: writeCalendarId,
    staff_calendars: staffCalendars,
    busy_calendar_ids: busyCalendarIds,
    attribution: mode === 'color' ? { mode, colors } : { mode },
  };

  const { error } = await getSupabase(c.env)
    .from('shops')
    .update({ calendar_routing: routing })
    .eq('id', shopId);
  if (error) {
    console.error('[gcal-select] routing update failed:', error.message);
    return c.html(
      page(
        "<h1>We couldn't save your choice</h1><p>Please try the link again, or reply to your welcome email and we'll finish it.</p>",
      ),
      500,
    );
  }

  // Appointments can be booked after the phone line is activated but before Google is connected.
  // Put every still-relevant orphan into the existing repair queue so the next calendar-sync tick
  // creates the events; otherwise those bookings remain invisible to the owner's calendar forever.
  const { error: backfillError } = await getSupabase(c.env)
    .from('bookings')
    .update({ gcal_sync_pending: true })
    .eq('shop_id', shopId)
    .eq('status', 'confirmed')
    .is('gcal_event_id', null)
    .gte('end_at', new Date().toISOString());
  if (backfillError) {
    console.error('[gcal-select] pending booking backfill failed:', backfillError.message);
    return c.html(
      page(
        "<h1>Calendar connected, but sync needs attention</h1><p>Please try saving once more, or reply to your welcome email and we'll finish it.</p>",
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
