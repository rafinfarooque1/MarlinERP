/**
 * Centralised password hashing and verification using bcryptjs.
 *
 * bcryptjs is pure JavaScript — no native compilation required, maximally portable
 * across Node.js versions and hosting providers.
 *
 * Work factor 12 is the recommended production minimum (≈300 ms per hash on
 * modern hardware — slow enough to resist brute-force, fast enough for UX).
 *
 * RULES:
 *  - Never store plaintext passwords. Always call hash() before persisting.
 *  - Always call verify() for comparisons — never compare strings directly.
 *  - Never log or return the result of hash() to the client.
 */
import bcryptjs from 'bcryptjs';

const WORK_FACTOR = 12;

export const PasswordService = {
  /** Hash a plaintext password. Returns the bcrypt hash string. */
  async hash(plaintext: string): Promise<string> {
    return bcryptjs.hash(plaintext, WORK_FACTOR);
  },

  /**
   * Verify a plaintext password against a stored bcrypt hash.
   * Returns false (not an error) if the stored value is not a valid bcrypt hash,
   * so calling this on a legacy plaintext value is safe — it simply fails.
   */
  async verify(plaintext: string, stored: string): Promise<boolean> {
    if (!PasswordService.isHashed(stored)) return false;
    return bcryptjs.compare(plaintext, stored);
  },

  /**
   * Returns true when the value looks like a bcrypt hash ($2a$ or $2b$ prefix).
   * Use this to detect legacy plaintext values that still need migration.
   */
  isHashed(value: string): boolean {
    return value.startsWith('$2a$') || value.startsWith('$2b$');
  },
};
