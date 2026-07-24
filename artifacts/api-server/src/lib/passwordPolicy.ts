/**
 * Centralised password policy.
 *
 * All routes that accept a new password MUST call validatePassword() before
 * hashing. Do NOT duplicate this logic across route files — update it here only.
 */

export interface PolicyResult {
  valid: boolean;
  error?: string;
}

/**
 * The company's standard initial credential issued when creating accounts or
 * resetting passwords. NEVER store this as plaintext — always hash with
 * PasswordService.hash() before persisting.
 */
export const DEFAULT_INITIAL_PASSWORD = '1234';

/** Validate that a password meets the minimum policy requirements. */
export function validatePassword(password: string): PolicyResult {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  return { valid: true };
}
