import type { WorkerBindings } from '../types';
import { decrypt } from './crypto';

interface GCalCreds {
  client_email: string;
  private_key: string;
  calendar_id: string;
}

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

export async function getGCalClient(
  env: WorkerBindings,
  encryptedCreds: string,
): Promise<GCalCreds & { token: string }> {
  const creds: GCalCreds = JSON.parse(await decrypt(encryptedCreds, env.ENCRYPTION_KEY));
  const token = await getToken(creds);
  return { ...creds, token };
}

export async function gcalCreateEvent(
  calendarId: string,
  token: string,
  summary: string,
  description: string,
  startIso: string,
  endIso: string,
  timeZone: string,
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
