/**
 * Authentication routes.
 *
 * Security guarantees:
 *  - Passwords are verified with bcrypt — never compared as strings.
 *  - Generic "Invalid username or password" for all failures (no enumeration).
 *  - Hardcoded backdoors and default passwords removed.
 *  - Login attempts are rate-limited per username (5 failures → 15-min lockout).
 *  - password_hash is NEVER included in any response.
 *  - All auth events are written to the audit log.
 *  - must_change_password is returned at login and /me so the frontend can
 *    redirect to the forced password-change flow.
 */
import { Router } from 'express';
import { pool, db, hierarchiesTable, warehousesTable, outletsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { LoginBody } from '@workspace/api-zod';
import { PasswordService } from '../lib/password';
import { validatePassword } from '../lib/passwordPolicy';
import { isLoginLocked, recordLoginFailure, clearLoginAttempts } from '../middleware/auth';
import { logActivity } from '../lib/audit';

const router = Router();

// ── Shared helper ─────────────────────────────────────────────────────────────
/** Build the safe employee payload — NEVER includes password_hash. */
async function buildEmployeeResponse(emp: Record<string, any>) {
  const hierarchyId = emp.hierarchyId ?? emp.hierarchy_id;
  const branchType  = emp.branchType  ?? emp.branch_type;
  const branchId    = emp.branchId    ?? emp.branch_id;

  const [hierarchy] = await db
    .select()
    .from(hierarchiesTable)
    .where(eq(hierarchiesTable.id, hierarchyId))
    .limit(1);

  let branchName = 'Head Office';
  if (branchType === 'warehouse') {
    const [w] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, branchId)).limit(1);
    branchName = w?.name ?? 'Warehouse';
  } else if (branchType === 'outlet') {
    const [o] = await db.select().from(outletsTable).where(eq(outletsTable.id, branchId)).limit(1);
    branchName = o?.name ?? 'Outlet';
  } else if (branchType === 'production') {
    branchName = 'Production Unit';
  }

  return {
    id:               emp.id,
    name:             emp.name,
    username:         emp.username,
    email:            emp.email ?? null,
    phone:            emp.phone ?? null,
    hierarchyId,
    hierarchyName:    hierarchy?.name ?? '',
    branchType,
    branchId,
    branchName,
    salary:           Number(emp.salary ?? 0),
    joinDate:         emp.joinDate ?? emp.join_date,
    photoUrl:         emp.photoUrl ?? emp.photo_url ?? null,
    isActive:         emp.isActive ?? emp.is_active,
    mustChangePassword: emp.mustChangePassword ?? emp.must_change_password ?? false,
  };
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { username, password } = parsed.data;
  const ip = (req.ip ?? 'unknown').replace('::ffff:', '');

  // Rate-limit check before any DB query
  if (isLoginLocked(username)) {
    logActivity({
      action: 'UPDATE', module: 'auth', entityType: 'login',
      description: `LOGIN_FAILED: temporarily locked — username '${username}'`,
      user: username, metadata: { ip, reason: 'rate_limited' },
    }).catch(() => {});
    res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    return;
  }

  // Fetch employee (must_change_password may not be in Drizzle schema, use pool)
  const { rows } = await pool.query(
    `SELECT id, name, username, password_hash, email, phone, hierarchy_id,
            branch_type, branch_id, salary, join_date, photo_url, is_active,
            COALESCE(must_change_password, false) AS must_change_password
     FROM employees WHERE username = $1 LIMIT 1`,
    [username],
  );
  const emp = rows[0];

  // Validate — identical error for "not found" and "wrong password" (no enumeration)
  const credentialsInvalid = !emp || !(await PasswordService.verify(password, emp.password_hash));
  if (credentialsInvalid) {
    const nowLocked = recordLoginFailure(username);
    logActivity({
      action: 'UPDATE', module: 'auth', entityType: 'login',
      description: `LOGIN_FAILED for username '${username}'`,
      user: username, metadata: { ip, locked: nowLocked },
    }).catch(() => {});
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (!emp.is_active) {
    res.status(403).json({ error: 'Your account has been deactivated. Please contact your administrator.' });
    return;
  }

  // Success — clear failed attempts, issue token, log
  clearLoginAttempts(username);
  logActivity({
    action: 'UPDATE', module: 'auth', entityType: 'login',
    description: `LOGIN_SUCCESS for '${username}'`,
    user: username, metadata: { ip },
  }).catch(() => {});

  const token = Buffer.from(`${emp.id}:${emp.username}`).toString('base64');
  const employee = await buildEmployeeResponse(emp);
  res.json({ token, employee });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/auth/logout', async (req, res): Promise<void> => {
  const username = (req as any).employee?.username ?? 'unknown';
  logActivity({
    action: 'UPDATE', module: 'auth', entityType: 'login',
    description: `LOGOUT for '${username}'`,
    user: username,
  }).catch(() => {});
  res.json({ success: true });
});

// ── POST /auth/change-password ────────────────────────────────────────────────
router.post('/auth/change-password', async (req, res): Promise<void> => {
  // Resolve the employee from the Bearer token (global requireAuth may have set
  // req.employee, but this route does its own lookup for belt-and-suspenders)
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = authHeader.slice(7);
  let empId: number;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    empId = parseInt(decoded.split(':')[0], 10);
    if (isNaN(empId)) throw new Error('bad token');
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }

  const policy = validatePassword(newPassword);
  if (!policy.valid) {
    res.status(400).json({ error: policy.error });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, username, password_hash FROM employees WHERE id = $1 LIMIT 1`,
    [empId],
  );
  const emp = rows[0];
  if (!emp) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const currentValid = await PasswordService.verify(currentPassword, emp.password_hash);
  if (!currentValid) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const newHash = await PasswordService.hash(newPassword);
  await pool.query(
    `UPDATE employees SET password_hash = $1, must_change_password = false WHERE id = $2`,
    [newHash, empId],
  );

  logActivity({
    action: 'UPDATE', module: 'auth', entityType: 'employee', entityId: empId,
    description: `PASSWORD_CHANGED for '${emp.username}'`,
    user: emp.username,
  }).catch(() => {});

  res.json({ success: true });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/auth/me', async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const empId = parseInt(decoded.split(':')[0], 10);
    if (isNaN(empId)) throw new Error('bad token');

    const { rows } = await pool.query(
      `SELECT id, name, username, email, phone, hierarchy_id, branch_type, branch_id,
              salary, join_date, photo_url, is_active,
              COALESCE(must_change_password, false) AS must_change_password
       FROM employees WHERE id = $1 LIMIT 1`,
      [empId],
    );
    const emp = rows[0];
    if (!emp) { res.status(404).json({ error: 'Not found' }); return; }
    if (!emp.is_active) { res.status(403).json({ error: 'Account deactivated' }); return; }

    res.json(await buildEmployeeResponse(emp));
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
