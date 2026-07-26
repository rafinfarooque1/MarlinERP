/**
 * Centralised password policy.
 *
 * All routes that accept a new password MUST call validatePassword() before
 * hashing. Do NOT duplicate this logic across route files — update it here only.
 *
 * The policy is configurable in Company Settings (password_min_length,
 * password_require_uppercase, password_require_number, password_require_special
 * columns added by startup migration). Reads are cached for 30s so login-adjacent
 * paths don't hit the DB every time.
 */
import { pool } from '@workspace/db';

export interface PolicyResult {
  valid: boolean;
  error?: string;
}

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
}

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: false,
  requireNumber: false,
  requireSpecial: false,
};

/**
 * The company's standard initial credential issued when creating accounts or
 * resetting passwords. NEVER store this as plaintext — always hash with
 * PasswordService.hash() before persisting. Accounts seeded with it carry
 * must_change_password=true, so the (stricter) policy is enforced the moment
 * the employee picks their own password.
 */
export const DEFAULT_INITIAL_PASSWORD = '1234';

let cached: { policy: PasswordPolicy; at: number } | null = null;
const CACHE_MS = 30_000;

/** Invalidate the cached policy (call after Company Settings updates it). */
export function invalidatePolicyCache(): void {
  cached = null;
}

/** Read the configured password policy from company_settings (30s cache). */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.policy;
  try {
    const { rows: [r] } = await pool.query(
      `SELECT password_min_length, password_require_uppercase,
              password_require_number, password_require_special
       FROM company_settings LIMIT 1`,
    );
    const policy: PasswordPolicy = {
      minLength: Math.min(Math.max(Number(r?.password_min_length ?? 8) || 8, 6), 32),
      requireUppercase: !!r?.password_require_uppercase,
      requireNumber: !!r?.password_require_number,
      requireSpecial: !!r?.password_require_special,
    };
    cached = { policy, at: Date.now() };
    return policy;
  } catch {
    return DEFAULT_POLICY; // table/columns not migrated yet
  }
}

/** Validate that a password meets the configured policy requirements. */
export async function validatePassword(password: string): Promise<PolicyResult> {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  const policy = await getPasswordPolicy();
  if (password.length < policy.minLength) {
    return { valid: false, error: `Password must be at least ${policy.minLength} characters` };
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character' };
  }
  return { valid: true };
}
