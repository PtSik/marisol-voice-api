import type { WorkerBindings } from '../types';
import { sendDiscordAlert } from './discord';
import { CALLABLE_STATUSES, canServeCalls } from './shop-status';
import { getSupabase } from './supabase';

export type GcalFailureOp = 'busy' | 'write' | 'token' | 'sync';
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
        action: 'gcal_failure',
        payload: { ...failure, kind: classifyFailure(failure.message) },
      });
  } catch (err) {
    console.error('[gcal-alert] log failed:', err instanceof Error ? err.message : err);
  }
}

// A calendar-driven move that collides with another booking cannot be applied — calendar
// and Supabase stay divorced until a human steps in, so it must never be a quiet log line.
export async function logGcalMoveConflict(
  env: WorkerBindings,
  shopId: string,
  payload: { booking_id: string; calendar_id: string; start_at: string; end_at: string },
): Promise<void> {
  try {
    await getSupabase(env)
      .from('audit_log')
      .insert({ shop_id: shopId, action: 'gcal_move_conflict', payload });
  } catch (err) {
    console.error('[gcal-alert] log failed:', err instanceof Error ? err.message : err);
  }
}

interface FailureRow {
  shop_id: string | null;
  action?: string;
  payload: { op?: string; kind?: string; calendar_id?: string; message?: string } | null;
  shops: { name: string; status?: string } | null;
}

export interface CalendarAlert {
  shopId: string;
  body: string;
}

export function alertLines(rows: FailureRow[]): CalendarAlert[] {
  const byShop = new Map<
    string,
    { name: string; auth: number; transient: number; moves: number }
  >();
  for (const row of rows) {
    if (!row.shop_id || !canServeCalls(row.shops?.status)) continue;
    const entry = byShop.get(row.shop_id) ?? {
      name: row.shops?.name ?? row.shop_id,
      auth: 0,
      transient: 0,
      moves: 0,
    };
    if (row.action === 'gcal_move_conflict') entry.moves++;
    else if (row.payload?.kind === 'auth') entry.auth++;
    else entry.transient++;
    byShop.set(row.shop_id, entry);
  }

  const alerts: CalendarAlert[] = [];
  for (const [shopId, entry] of byShop) {
    // A move conflict alerts from the first occurrence: sync refused the change, so the
    // calendar disagrees with the register until someone fixes it by hand.
    if (entry.moves > 0) {
      alerts.push({
        shopId,
        body: `Marisol: ${entry.name} — ${entry.moves} calendar event move${entry.moves > 1 ? 's' : ''} collide with existing bookings and were not applied. Calendar and bookings disagree; manual fix needed.`,
      });
    }
    if (entry.auth > 0) {
      alerts.push({
        shopId,
        body: `Marisol: ${entry.name} lost Google Calendar access (${entry.auth} auth failure${entry.auth > 1 ? 's' : ''} in the last hour). Their calendar has stopped syncing — reconnect needed.`,
      });
    } else if (entry.transient >= TRANSIENT_ALERT_THRESHOLD) {
      alerts.push({
        shopId,
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
  if (!env.DISCORD_ALERT_WEBHOOK_URL) return { alerted: 0 };

  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data, error } = await getSupabase(env)
    .from('audit_log')
    .select('shop_id, action, payload, shops!inner(name, status)')
    .in('shops.status', CALLABLE_STATUSES)
    .in('action', ['gcal_failure', 'gcal_move_conflict'])
    .gte('created_at', since);
  if (error || !data) {
    console.log('[gcal-alert] select error:', error?.message);
    return { alerted: 0 };
  }

  const alerts = alertLines(data as unknown as FailureRow[]);
  let alerted = 0;
  for (const alert of alerts) {
    const sent = await sendDiscordAlert(env, alert.body);
    if (sent) alerted++;
    else console.log('[gcal-alert] Discord send failed for shop', alert.shopId);
  }
  return { alerted };
}
