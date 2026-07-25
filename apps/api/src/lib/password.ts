import { timingSafeEqual } from './crypto';

const ITERATIONS = 100_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function derive(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, iterationsStr, saltEncoded, hashEncoded, ...rest] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterationsStr || !saltEncoded || !hashEncoded || rest.length > 0) {
    return false;
  }

  const iterations = Number.parseInt(iterationsStr, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  try {
    salt = fromBase64Url(saltEncoded);
  } catch {
    return false;
  }

  const actual = await derive(plain, salt, iterations);
  return timingSafeEqual(toBase64Url(actual), hashEncoded);
}
