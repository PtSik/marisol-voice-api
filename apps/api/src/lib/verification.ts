import type { SupabaseClient } from '@supabase/supabase-js';

const CODE_TTL_MINUTES = 15;

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
export { BOOKING_CODE_TTL_MINUTES };

export async function storeCode(
  db: SupabaseClient,
  bookingId: string,
  code: string,
  ttlMinutes = CODE_TTL_MINUTES,
): Promise<void> {
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  const { error } = await db.from('verification_codes').insert({
    booking_id: bookingId,
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  if (error) throw new Error(`Failed to store verification code: ${error.message}`);
}

export async function verifyCode(
  db: SupabaseClient,
  bookingId: string,
  code: string,
): Promise<boolean> {
  const codeHash = await hashCode(code);
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('verification_codes')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('code_hash', codeHash)
    .is('used_at', null)
    .gt('expires_at', now)
    .limit(1)
    .single();

  if (error || !data) return false;

  // Mark as consumed
  await db.from('verification_codes').update({ used_at: now }).eq('id', data.id);

  return true;
}
