/**
 * Authentication middleware and login brute-force rate-limiter.
 *
 * requireAuth  — validates the Bearer token on every protected route and
 *                attaches req.employee.
 *
 * isLoginLocked / recordLoginFailure / clearLoginAttempts
 *              — in-memory per-username rate-limiter. Locks the account for
 *                15 minutes after 5 consecutive failed attempts. The lock
 *                self-expires; no admin action is required.
 */
import { Request, Response, NextFunction } from 'express';
import { pool } from '@workspace/db';

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

// ── In-memory brute-force protection ────────────────────────────────────────
interface LoginAttempt {
  count: number;
  lockedUntil?: number;
}

const loginAttempts = new Map<string, LoginAttempt>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export function isLoginLocked(username: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(username);
  if (!entry?.lockedUntil) return false;
  if (entry.lockedUntil < now) {
    loginAttempts.delete(username);
    return false;
  }
  return true;
}

/** Record a failed login attempt. Returns true if the account is now locked. */
export function recordLoginFailure(username: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(username) ?? { count: 0 };

  // Reset stale lock
  if (entry.lockedUntil && entry.lockedUntil < now) {
    loginAttempts.set(username, { count: 1 });
    return false;
  }

  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    loginAttempts.set(username, entry);
    return true;
  }
  loginAttempts.set(username, entry);
  return false;
}

export function clearLoginAttempts(username: string): void {
  loginAttempts.delete(username);
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
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [idStr] = decoded.split(':');
    const empId = parseInt(idStr, 10);
    if (isNaN(empId)) throw new Error('invalid token');

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
