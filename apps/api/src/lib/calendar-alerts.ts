import type { WorkerBindings } from '../types';
import { sendSms } from './sms';
import { getSupabase } from './supabase';

export type GcalFailureOp = 'busy' | 'write' | 'token';
export type GcalFailureKind = 'auth' | 'transient';

export interface GcalFailure {
  op: GcalFailureOp;
  calendar_id?: string;
  message: string;
}

// A revoked grant is permanent: the feature is dead until someone reconnects, and a quiet
// shop would never reach a count threshold. Timeouts and 5xx are masked by fail-open, so
// they only matter in bulk.
export function classifyFailure(message: string): GcalFailureKind {
  return /invalid_grant|unauthorized|\b401\b|\b403\b/i.test(message) ? 'auth' : 'transient';
}

const TRANSIENT_ALERT_THRESHOLD = 3;

// Best-effort: calendar failures are already non-fatal, so logging one must never be the
// thing that breaks a call.
export async function logGcalFailure(
  env: WorkerBindings,
  shopId: string,
  failure: GcalFailure,
): Promise<void> {
  try {
    await getSupabase(env)
      .from('audit_log')
      .insert({
        shop_id: shopId,
        actor: 'system',
        action: 'gcal_failure',
        payload: { ...failure, kind: classifyFailure(failure.message) },
      });
  } catch (err) {
    console.error('[gcal-alert] log failed:', err instanceof Error ? err.message : err);
  }
}

interface FailureRow {
  shop_id: string | null;
  payload: { op?: string; kind?: string; calendar_id?: string; message?: string } | null;
  shops: { name: string; twilio_number: string } | null;
}

export interface CalendarAlert {
  shopId: string;
  // Twilio rejects a From that isn't a number on the account, so alerts are sent from the
  // number of the shop they are about — never from the team's own phone.
  from: string;
  body: string;
}

export function alertLines(rows: FailureRow[]): CalendarAlert[] {
  const byShop = new Map<string, { name: string; from: string; auth: number; transient: number }>();
  for (const row of rows) {
    if (!row.shop_id) continue;
    const entry = byShop.get(row.shop_id) ?? {
      name: row.shops?.name ?? row.shop_id,
      from: row.shops?.twilio_number ?? '',
      auth: 0,
      transient: 0,
    };
    if (row.payload?.kind === 'auth') entry.auth++;
    else entry.transient++;
    byShop.set(row.shop_id, entry);
  }

  const alerts: CalendarAlert[] = [];
  for (const [shopId, entry] of byShop) {
    if (entry.auth > 0) {
      alerts.push({
        shopId,
        from: entry.from,
        body: `Marisol: ${entry.name} lost Google Calendar access (${entry.auth} auth failure${entry.auth > 1 ? 's' : ''} in the last hour). Their calendar has stopped syncing — reconnect needed.`,
      });
    } else if (entry.transient >= TRANSIENT_ALERT_THRESHOLD) {
      alerts.push({
        shopId,
        from: entry.from,
        body: `Marisol: ${entry.name} had ${entry.transient} Google Calendar failures in the last hour. Bookings still work; calendar reads/writes are degraded.`,
      });
    }
  }
  return alerts;
}

// Reads and writes both fail quietly (fail-open busy reads, waitUntil writes), so without
// this a revoked grant means a paid-for feature silently stops working.
export async function runCalendarAlerts(
  env: WorkerBindings,
  nowMs = Date.now(),
): Promise<{ alerted: number }> {
  if (!env.TEAM_ALERT_PHONE) return { alerted: 0 };

  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data, error } = await getSupabase(env)
    .from('audit_log')
    .select('shop_id, payload, shops(name, twilio_number)')
    .eq('action', 'gcal_failure')
    .gte('created_at', since);
  if (error || !data) {
    console.log('[gcal-alert] select error:', error?.message);
    return { alerted: 0 };
  }

  const alerts = alertLines(data as unknown as FailureRow[]);
  let alerted = 0;
  for (const alert of alerts) {
    // The team gets these, not the shop: only we can walk an owner through reconnecting.
    const from = env.TWILIO_SMS_FROM || alert.from;
    if (!from) {
      console.log('[gcal-alert] no sender number for shop', alert.shopId);
      continue;
    }
    const sent = await sendSms(env, from, env.TEAM_ALERT_PHONE, alert.body);
    if (sent) alerted++;
    else console.log('[gcal-alert] send failed for shop', alert.shopId);
  }
  return { alerted };
}
