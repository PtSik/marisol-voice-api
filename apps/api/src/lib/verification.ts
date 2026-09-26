import type { SupabaseClient } from '@supabase/supabase-js';

export function generateCode(): string {
  const digits = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(digits)
    .map((b) => b % 10)
    .join('');
}

export async function hashCode(code: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(code));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const BOOKING_CODE_TTL_MINUTES = 30 * 24 * 60;

export async function storeCode(
  db: SupabaseClient,
  bookingId: string,
  code: string,
): Promise<void> {
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + BOOKING_CODE_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await db.from('verification_codes').insert({
    booking_id: bookingId,
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  if (error) throw new Error(`Failed to store verification code: ${error.message}`);
}

// Checking and consuming are one conditional UPDATE: Postgres re-evaluates `used_at IS NULL` under
// the row lock, so two requests racing with the same code cannot both get true.
export async function verifyCode(
  db: SupabaseClient,
  bookingId: string,
  code: string,
): Promise<boolean> {
  const codeHash = await hashCode(code);
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('verification_codes')
    .update({ used_at: now })
    .eq('booking_id', bookingId)
    .eq('code_hash', codeHash)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('id');

  return !error && (data?.length ?? 0) > 0;
}

// Hands a consumed code back when the change it authorised was not written, so the caller's retry
// is not refused as "invalid code" for a booking that never changed.
export async function releaseCode(
  db: SupabaseClient,
  bookingId: string,
  code: string,
): Promise<void> {
  const { error } = await db
    .from('verification_codes')
    .update({ used_at: null })
    .eq('booking_id', bookingId)
    .eq('code_hash', await hashCode(code));
  if (error) console.error(`[verification] release failed for ${bookingId}: ${error.message}`);
}
