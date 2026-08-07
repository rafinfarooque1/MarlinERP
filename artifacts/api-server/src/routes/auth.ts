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
import { optionalIsoDate } from '../lib/dateInput';
import { pool, db, hierarchiesTable, warehousesTable, outletsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { LoginBody } from '@workspace/api-zod';
import { PasswordService } from '../lib/password';
import { validatePassword } from '../lib/passwordPolicy';
import { checkLoginLock, recordLoginFailure, clearLoginFailures } from '../middleware/auth';
import { signToken, verifyToken } from '../lib/token';
import { logActivity } from '../lib/audit';

const router = Router();

/** Persist a login attempt row (fire-and-forget — never blocks the response). */
function recordLoginHistory(entry: {
  username: string; employeeId?: number | null; success: boolean;
  ip?: string; userAgent?: string; reason?: string;
}): void {
  pool.query(
    `INSERT INTO login_attempts (username, employee_id, success, ip, user_agent, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.username, entry.employeeId ?? null, entry.success,
     entry.ip ?? null, (entry.userAgent ?? '').slice(0, 300) || null, entry.reason ?? null],
  ).catch(() => {});
}

/** Resolve the employee id from the request's Bearer token, or null. */
function empIdFromRequest(req: { headers: { authorization?: string } }): number | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  const payload = verifyToken(h.slice(7));
  return payload?.id ?? null;
}

// ── Shared helper ─────────────────────────────────────────────────────────────
/** Build the safe employee payload — NEVER includes password_hash. */
async function buildEmployeeResponse(emp: Record<string, any>) {
  const hierarchyId = emp.hierarchyId ?? emp.hierarchy_id;
  // 'production' was retired as a branch type (Production is a Head Office
  // department) — normalize any legacy value from old rows or sessions.
  const rawBranchType = emp.branchType ?? emp.branch_type;
  const branchType  = rawBranchType === 'production' ? 'headoffice' : rawBranchType;
  const branchId    = rawBranchType === 'production' ? 1 : (emp.branchId ?? emp.branch_id);

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
    // Personal profile fields
    education:        emp.education ?? [],
    workExperience:   emp.work_experience ?? [],
    emergencyContact: emp.emergency_contact ?? null,
    personalAddress:  emp.personal_address ?? null,
    dateOfBirth:      emp.date_of_birth ?? null,
    bio:              emp.bio ?? null,
    // Persisted global location selection (JSON string or null). The client
    // treats it as a display preference — never as authority.
    uiLocationPref:   emp.ui_location_pref ?? emp.uiLocationPref ?? null,
  };
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  // Accidental whitespace (mobile keyboards, copy-paste) must never turn into
  // a silent "invalid credentials": trim before anything looks at the value.
  const username = parsed.data.username.trim();
  const { password } = parsed.data;
  const ip = (req.ip ?? 'unknown').replace('::ffff:', '');

  const userAgent = req.headers['user-agent'] ?? '';

  // Lockout check before any credential work. The state is durable
  // (login_lockouts table): it survives restarts and is shared by every
  // instance. A genuine lock is reported AS a lock with the remaining time —
  // never disguised as wrong credentials.
  const lock = await checkLoginLock(username);
  if (lock.locked) {
    const minutes = Math.max(1, Math.ceil((lock.retryAfterSeconds ?? 60) / 60));
    logActivity({
      action: 'UPDATE', module: 'auth', entityType: 'login',
      description: `LOGIN_FAILED: temporarily locked — username '${username}'`,
      user: username, metadata: { ip, reason: 'rate_limited', lockedUntil: lock.lockedUntil?.toISOString() },
    }).catch(() => {});
    recordLoginHistory({ username, success: false, ip, userAgent, reason: 'rate_limited' });
    res.set('Retry-After', String(lock.retryAfterSeconds ?? 60));
    res.status(429).json({
      error: `Too many failed attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      lockedUntil: lock.lockedUntil?.toISOString(),
      retryAfterSeconds: lock.retryAfterSeconds,
    });
    return;
  }

  // Fetch employee (must_change_password may not be in Drizzle schema, use pool).
  // Lookup normalizes BOTH sides with LOWER(TRIM(...)) — the same expression
  // as the unique index and the lockout key — so "Admin" typed by an auto-
  // capitalizing phone keyboard reaches the same account as "admin", and a
  // stored username that somehow carries whitespace can still sign in.
  // (The input $1 is already trimmed above.)
  const { rows } = await pool.query(
    `SELECT id, name, username, password_hash, email, phone, hierarchy_id,
            branch_type, branch_id, salary, join_date, photo_url, is_active,
            COALESCE(must_change_password, false) AS must_change_password
     FROM employees WHERE LOWER(TRIM(username)) = LOWER($1)
     ORDER BY (username = $1) DESC, id ASC LIMIT 1`,
    [username],
  );
  const emp = rows[0];

  // Validate — identical error for "not found" and "wrong password" (no enumeration)
  const credentialsInvalid = !emp || !(await PasswordService.verify(password, emp.password_hash));
  if (credentialsInvalid) {
    const { locked: nowLocked } = await recordLoginFailure(username);
    logActivity({
      action: 'UPDATE', module: 'auth', entityType: 'login',
      description: `LOGIN_FAILED for username '${username}'`,
      user: username, metadata: { ip, locked: nowLocked },
    }).catch(() => {});
    recordLoginHistory({
      username, employeeId: emp?.id ?? null, success: false, ip, userAgent,
      reason: nowLocked ? 'invalid_credentials_locked' : 'invalid_credentials',
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (!emp.is_active) {
    recordLoginHistory({ username, employeeId: emp.id, success: false, ip, userAgent, reason: 'account_deactivated' });
    res.status(403).json({ error: 'Your account has been deactivated. Please contact your administrator.' });
    return;
  }

  // Success — clear failed attempts, issue token, log
  await clearLoginFailures(username);
  logActivity({
    action: 'UPDATE', module: 'auth', entityType: 'login',
    description: `LOGIN_SUCCESS for '${username}'`,
    user: username, metadata: { ip },
  }).catch(() => {});

  recordLoginHistory({ username, employeeId: emp.id, success: true, ip, userAgent });

  const token = signToken(emp.id, emp.username);
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
  const empId = empIdFromRequest(req);
  if (empId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }

  const policy = await validatePassword(newPassword);
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
    // 400, NOT 401: the bearer token is valid — only the typed form field is
    // wrong. Both clients treat a confirmed 401 as an expired session and log
    // the user out, which would eject anyone who typos their current password.
    res.status(400).json({ error: 'Current password is incorrect' });
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
  const empId = empIdFromRequest(req);
  if (empId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, username, email, phone, hierarchy_id, branch_type, branch_id,
              salary, join_date, photo_url, is_active,
              COALESCE(must_change_password, false) AS must_change_password,
              COALESCE(education, '[]'::jsonb) AS education,
              COALESCE(work_experience, '[]'::jsonb) AS work_experience,
              emergency_contact, personal_address, date_of_birth, bio, ui_location_pref
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

// ── PUT /auth/location-pref — persist the global location selection ──────────
// A DISPLAY preference only: it drives which location the UI shows on the next
// login, never what the user is allowed to see (LBAC stays unconditional).
// Stored as a JSON string so "picked All" is distinguishable from "never set".
router.put('/auth/location-pref', async (req, res): Promise<void> => {
  const empId = empIdFromRequest(req);
  if (empId == null) { res.status(401).json({ error: 'Authentication required' }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const locationType = body.locationType;
  if (locationType !== 'all' && locationType !== 'warehouse' && locationType !== 'outlet' && locationType !== 'headoffice') {
    res.status(400).json({ error: "locationType must be 'all', 'headoffice', 'warehouse' or 'outlet'" }); return;
  }
  let pref: { locationType: string; locationId?: number; locationName?: string };
  if (locationType === 'all') {
    pref = { locationType: 'all' };
  } else if (locationType === 'headoffice') {
    // Singular — no id needed; the UI restores it by type.
    pref = { locationType: 'headoffice', locationId: 1, locationName: 'Head Office' };
  } else {
    const locationId = Number(body.locationId);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      res.status(400).json({ error: 'locationId must be a positive integer' }); return;
    }
    const locationName =
      typeof body.locationName === 'string' ? body.locationName.slice(0, 200) : undefined;
    pref = { locationType, locationId, ...(locationName ? { locationName } : {}) };
  }

  await pool.query(`UPDATE employees SET ui_location_pref = $1 WHERE id = $2`, [
    JSON.stringify(pref), empId,
  ]);
  res.json({ success: true, uiLocationPref: JSON.stringify(pref) });
});

// ── PATCH /auth/profile — employee updates their own profile ──────────────────
router.patch('/auth/profile', async (req, res): Promise<void> => {
  const empId = empIdFromRequest(req);
  if (empId == null) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { name, phone, email, photoUrl, education, workExperience, emergencyContact, personalAddress, dateOfBirth, bio } = req.body as Record<string, any>;

  const sets: string[] = [];
  const vals: any[] = [];
  const add = (col: string, val: any) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };

  if (name           !== undefined) add('name', name);
  if (phone          !== undefined) add('phone', phone);
  if (email          !== undefined) add('email', email);
  if (photoUrl       !== undefined) add('photo_url', photoUrl);
  if (education        !== undefined) add('education', JSON.stringify(education));
  if (workExperience   !== undefined) add('work_experience', JSON.stringify(workExperience));
  if (emergencyContact !== undefined) add('emergency_contact', JSON.stringify(emergencyContact));
  if (personalAddress !== undefined) add('personal_address', personalAddress);
  // date_of_birth is a real DATE column: an empty profile field must store NULL
  // rather than '' (22007), and a malformed value is a 400, not a driver error.
  if (dateOfBirth    !== undefined) {
    const dob = optionalIsoDate(dateOfBirth);
    if (!dob.ok) { res.status(400).json({ error: 'dateOfBirth must be a real calendar date in YYYY-MM-DD form' }); return; }
    add('date_of_birth', dob.value);
  }
  if (bio            !== undefined) add('bio', bio);

  if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

  vals.push(empId);
  const { rows } = await pool.query(
    `UPDATE employees SET ${sets.join(', ')} WHERE id=$${vals.length}
     RETURNING id, name, username, email, phone, hierarchy_id, branch_type, branch_id,
               salary, join_date, photo_url, is_active,
               COALESCE(must_change_password, false) AS must_change_password,
               COALESCE(education, '[]'::jsonb) AS education,
               COALESCE(work_experience, '[]'::jsonb) AS work_experience,
               emergency_contact, personal_address, date_of_birth, bio, ui_location_pref`,
    vals,
  );
  if (!rows[0]) { res.status(404).json({ error: 'Employee not found' }); return; }

  logActivity({
    action: 'UPDATE', module: 'auth', entityType: 'employee', entityId: empId,
    description: `Employee updated own profile (fields: ${Object.keys(req.body).join(', ')})`,
  }).catch(() => {});

  res.json(await buildEmployeeResponse(rows[0]));
});

export default router;
