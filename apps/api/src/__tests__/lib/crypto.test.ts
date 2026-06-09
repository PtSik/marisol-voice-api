import { describe, expect, it } from 'bun:test';
import { decrypt, encrypt } from '../../lib/crypto';

const TEST_KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('round-trips plaintext through encrypt → decrypt', async () => {
    const plaintext = 'hello world secret';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('throws when decrypting with wrong key', async () => {
    const encrypted = await encrypt('some secret', TEST_KEY);
    const wrongKey = 'b'.repeat(64);
    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

  it('produces different ciphertext on each call (non-deterministic IV)', async () => {
    const plaintext = 'same input';
    const first = await encrypt(plaintext, TEST_KEY);
    const second = await encrypt(plaintext, TEST_KEY);
    expect(first).not.toBe(second);
  });
});
