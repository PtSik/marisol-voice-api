import { describe, expect, it } from 'bun:test';
import { hashPassword, verifyPassword } from '../../lib/password';

describe('password', () => {
  it('round-trips a password through hash → verify', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('produces a different hash on each call (random salt)', async () => {
    const first = await hashPassword('same input');
    const second = await hashPassword('same input');
    expect(first).not.toBe(second);
  });

  it('encodes as pbkdf2$<iterations>$<salt>$<hash> with iterations >= 100000', async () => {
    const hash = await hashPassword('anything');
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(Number.parseInt(parts[1] ?? '', 10)).toBeGreaterThanOrEqual(100_000);
  });

  it('returns false instead of throwing on a malformed stored value', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'pbkdf2$abc$salt$hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'sha1$100000$salt$hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});
