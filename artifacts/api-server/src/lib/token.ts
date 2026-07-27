/**
 * Session-token signing & verification.
 *
 * v2 tokens are HMAC-SHA256 signed with SESSION_SECRET:
 *     v2.<base64url(id:username:issuedAtMs)>.<base64url(hmac)>
 * A tampered payload (e.g. swapping the employee id) fails signature
 * verification.
 *
 * Legacy unsigned `base64(id:username)` tokens are REJECTED: they carry no
 * signature, so anyone who can guess an employee id could forge one. Users
 * holding a legacy token get a 401 and simply log in again once.
 *
 * Token max-age is 8 hours by default; override with TOKEN_MAX_AGE_HOURS env.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const KEY = process.env.SESSION_SECRET || '';
if (!KEY) {
  // Fail closed at boot: a predictable fallback key would let anyone forge
  // valid session tokens. The server must not run without a real secret.
  throw new Error(
    '[token] SESSION_SECRET is not set — refusing to start without a session-token signing key.',
  );
}

/** Token max-age in milliseconds. Default: 8 hours. */
const TOKEN_MAX_AGE_MS =
  parseInt(process.env.TOKEN_MAX_AGE_HOURS ?? '8', 10) * 60 * 60 * 1000;

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const hmac = (payload: string): string =>
  b64url(createHmac('sha256', KEY).update(payload).digest());

export interface TokenPayload {
  id: number;
  username: string;
  /** Unix timestamp (ms) when the token was issued. */
  issuedAt: number;
}

/** Issue a signed v2 session token. */
export function signToken(id: number, username: string): string {
  const payload = b64url(Buffer.from(`${id}:${username}:${Date.now()}`, 'utf-8'));
  return `v2.${payload}.${hmac(payload)}`;
}

/**
 * Verify a signed v2 bearer token.
 * Returns null when:
 *   • format is wrong or signature fails
 *   • token has no issuedAt timestamp
 *   • token is older than TOKEN_MAX_AGE_MS (default 8 hours)
 */
export function verifyToken(token: string): TokenPayload | null {
  if (!token || !token.startsWith('v2.')) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const decoded = fromB64url(payload).toString('utf-8');
  // payload format: "id:username:issuedAtMs"
  // Username may contain colons (e.g. email addresses), so split on the
  // first and last colon only to isolate id and timestamp.
  const firstColon = decoded.indexOf(':');
  const lastColon = decoded.lastIndexOf(':');
  if (firstColon === -1 || lastColon <= firstColon) return null;

  const idStr = decoded.slice(0, firstColon);
  const username = decoded.slice(firstColon + 1, lastColon);
  const issuedAtStr = decoded.slice(lastColon + 1);

  const id = parseInt(idStr, 10);
  const issuedAt = parseInt(issuedAtStr, 10);

  if (!Number.isFinite(id) || id <= 0 || !username) return null;

  // Reject tokens that carry no issue timestamp (format pre-dates v2).
  if (!Number.isFinite(issuedAt)) return null;

  // Reject expired tokens.
  if (Date.now() - issuedAt > TOKEN_MAX_AGE_MS) return null;

  return { id, username, issuedAt };
}
