/**
 * Authentication middleware and login brute-force rate-limiter.
 *
 * requireAuth  — validates the Bearer token on every protected route and
 *                attaches req.employee.
 *
 * checkLoginLock / recordLoginFailure / clearLoginFailures
 *              — DURABLE per-username rate-limiter backed by the
 *                login_lockouts table. Locks the account for 15 minutes after
 *                5 failed attempts within a 15-minute window. The lock
 *                self-expires; a successful login clears the counter; no
 *                admin action is required.
 *
 * Why the database and not process memory: an in-memory Map is wiped by every
 * restart ("works after a redeploy"), and each instance of a multi-instance
 * deployment keeps its own copy, so whether a user is locked depended on which
 * instance answered. State now lives in one place, survives restarts, and is
 * updated with a single atomic upsert so concurrent failures cannot corrupt
 * the counter.
 */
import { Request, Response, NextFunction } from 'express';
import { pool } from '@workspace/db';
import { verifyToken } from '../lib/token';

// ── Express type augmentation ────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      employee?: {
        id: number;
        username: string;
        hierarchyId: number;
        branchType: string;
        branchId: number;
        isActive: boolean;
      };
    }
  }
}

// ── Durable brute-force protection (login_lockouts table) ───────────────────
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;
// Failures only count toward a lock within this window. A stale client that
// fails once every few hours can therefore never accumulate a lock on its own,
// and a successful login wipes the counter entirely.
const WINDOW_MINUTES = 15;

/**
 * Lockout rows are keyed by the NORMALIZED username (trimmed, lower-cased) so
 * "Admin", "admin " and "admin" share one counter — login lookup is
 * case-insensitive, so they are all attempts against the same account.
 */
const lockKey = (username: string): string => username.trim().toLowerCase();

export interface LoginLockStatus {
  locked: boolean;
  lockedUntil?: Date;
  retryAfterSeconds?: number;
}

/** Is this username currently locked out? Reads the durable store. */
export async function checkLoginLock(username: string): Promise<LoginLockStatus> {
  const { rows } = await pool.query<{ locked_until: Date }>(
    `SELECT locked_until FROM login_lockouts
      WHERE username = $1 AND locked_until IS NOT NULL AND locked_until > now()`,
    [lockKey(username)],
  );
  if (!rows[0]) return { locked: false };
  const lockedUntil = new Date(rows[0].locked_until);
  return {
    locked: true,
    lockedUntil,
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Record a failed login attempt. Returns whether the account is now locked.
 *
 * One atomic upsert: ON CONFLICT takes a row lock, so concurrent failures
 * serialize on the row and every attempt is counted exactly once. A stale
 * window (older than WINDOW_MINUTES) or an expired lock resets the counter to
 * 1 instead of incrementing.
 */
export async function recordLoginFailure(
  username: string,
): Promise<{ locked: boolean; lockedUntil: Date | null; failureCount: number }> {
  const { rows } = await pool.query<{ failure_count: number; locked_until: Date | null }>(
    `INSERT INTO login_lockouts AS ll (username, failure_count, window_started_at, locked_until, updated_at)
     VALUES ($1, 1, now(), CASE WHEN 1 >= $2::int THEN now() + make_interval(mins => $3::int) END, now())
     ON CONFLICT (username) DO UPDATE SET
       failure_count = CASE
         WHEN ll.window_started_at < now() - make_interval(mins => $4::int)
              OR (ll.locked_until IS NOT NULL AND ll.locked_until <= now())
         THEN 1 ELSE ll.failure_count + 1 END,
       window_started_at = CASE
         WHEN ll.window_started_at < now() - make_interval(mins => $4::int)
              OR (ll.locked_until IS NOT NULL AND ll.locked_until <= now())
         THEN now() ELSE ll.window_started_at END,
       locked_until = CASE
         WHEN (CASE
                 WHEN ll.window_started_at < now() - make_interval(mins => $4::int)
                      OR (ll.locked_until IS NOT NULL AND ll.locked_until <= now())
                 THEN 1 ELSE ll.failure_count + 1 END) >= $2::int
         THEN now() + make_interval(mins => $3::int)
         WHEN ll.window_started_at < now() - make_interval(mins => $4::int)
              OR (ll.locked_until IS NOT NULL AND ll.locked_until <= now())
         THEN NULL
         ELSE ll.locked_until END,
       updated_at = now()
     RETURNING failure_count, locked_until`,
    [lockKey(username), MAX_FAILURES, LOCKOUT_MINUTES, WINDOW_MINUTES],
  );
  const row = rows[0];
  const lockedUntil = row?.locked_until ? new Date(row.locked_until) : null;
  return {
    locked: lockedUntil !== null && lockedUntil.getTime() > Date.now(),
    lockedUntil,
    failureCount: row?.failure_count ?? 1,
  };
}

/** A successful login (or an admin password reset) wipes the failure counter. */
export async function clearLoginFailures(username: string): Promise<void> {
  await pool.query(`DELETE FROM login_lockouts WHERE username = $1`, [lockKey(username)]);
}

/** Currently locked usernames with their lock expiry (for the Login History page). */
export async function getActiveLockouts(): Promise<
  Array<{ username: string; lockedUntil: string; failedAttempts: number }>
> {
  const { rows } = await pool.query<{ username: string; locked_until: Date; failure_count: number }>(
    `SELECT username, locked_until, failure_count FROM login_lockouts
      WHERE locked_until IS NOT NULL AND locked_until > now()
      ORDER BY locked_until DESC`,
  );
  return rows.map((r) => ({
    username: r.username,
    lockedUntil: new Date(r.locked_until).toISOString(),
    failedAttempts: r.failure_count,
  }));
}

// ── requireAuth middleware ───────────────────────────────────────────────────
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    if (!payload) throw new Error('invalid token');
    const empId = payload.id;

    const { rows } = await pool.query<{
      id: number;
      username: string;
      hierarchy_id: number;
      branch_type: string;
      branch_id: number;
      is_active: boolean;
    }>(
      `SELECT id, username, hierarchy_id, branch_type, branch_id, is_active
       FROM employees WHERE id = $1 LIMIT 1`,
      [empId],
    );

    const emp = rows[0];
    if (!emp || !emp.is_active) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.employee = {
      id: emp.id,
      username: emp.username,
      hierarchyId: emp.hierarchy_id,
      branchType: emp.branch_type,
      branchId: emp.branch_id,
      isActive: emp.is_active,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Authentication required' });
  }
}
