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

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const hmac = (payload: string): string =>
  b64url(createHmac('sha256', KEY).update(payload).digest());

export interface TokenPayload {
  id: number;
  username: string;
}

/** Issue a signed v2 session token. */
export function signToken(id: number, username: string): string {
  const payload = b64url(Buffer.from(`${id}:${username}:${Date.now()}`, 'utf-8'));
  return `v2.${payload}.${hmac(payload)}`;
}

/** Verify a signed v2 bearer token. Any other format returns null. */
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
  const [idStr, username] = decoded.split(':');
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || !username) return null;
  return { id, username };
}
