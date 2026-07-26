---
name: Marlin ERP Security Hardening
description: What was done, decisions made, and constraints to maintain for auth security
---

## What was implemented

- `reset-22d57e92.ts` deleted — this was an unauthenticated TRUNCATE ALL endpoint
- `artifacts/api-server/src/lib/password.ts` — PasswordService (bcryptjs, work factor 12)
- `artifacts/api-server/src/lib/passwordPolicy.ts` — validatePassword (8-char min) + DEFAULT_INITIAL_PASSWORD constant (single source of truth for the seeded/initial password — read the value from that file, never copy it here)
- `artifacts/api-server/src/middleware/auth.ts` — requireAuth middleware + in-memory rate limiter (5 failures → 15 min lockout per username)
- `artifacts/api-server/src/routes/auth.ts` — full rewrite; no backdoor, bcrypt verify, rate limiting, audit log (LOGIN_SUCCESS/FAILED/LOGOUT/PASSWORD_CHANGED), mustChangePassword in responses
- `artifacts/api-server/src/app.ts` — global requireAuth middleware for all /api routes; exempts /health and POST /auth/login
- `artifacts/api-server/src/routes/hr.ts` — employees created with PasswordService.hash(DEFAULT_INITIAL_PASSWORD) + mustChangePassword:true; POST/GET/PATCH responses all include mustChangePassword; added POST /hr/employees/:id/reset-password endpoint
- `lib/db/src/schema/hr.ts` — mustChangePassword: boolean("must_change_password").notNull().default(false) added
- `lib/api-zod/src/generated/types/employee.ts` — mustChangePassword?: boolean added
- Frontend: Login.tsx redirects to /change-password if mustChangePassword; ChangePassword.tsx has forced-flow banner and clears flag on success; App.tsx AuthGuard checks mustChangePassword and redirects

## Credentials

- Dev + Neon prod admin: username=admin, password = DEFAULT_INITIAL_PASSWORD (bcrypt $2b$12$ in DB), must_change_password=true
- New employees: initial password = DEFAULT_INITIAL_PASSWORD (hashed), must_change_password=true (forced change on first login)
- Password reset endpoint: POST /api/hr/employees/:id/reset-password — resets to the DEFAULT_INITIAL_PASSWORD hash with must_change_password=true

## Invariants to maintain

**Why:** The startup migration in index.ts is idempotent — it only updates employees where password_hash NOT LIKE '$2%', so it won't overwrite passwords that employees have already changed.

**How to apply:** Never add a new migration that sets password_hash to a plaintext value. Always use PasswordService.hash() before any INSERT/UPDATE to the password_hash column.

**Why:** The global requireAuth middleware in app.ts exempts only `/health`, `POST /auth/login`, and `GET /public/invoices/*` (HMAC-tokenized invoice PDFs — see invoice-pdf-links.md). Adding new public endpoints requires adding explicit exemptions there.

## Session tokens

**Rule:** Only HMAC-signed v2 tokens (`v2.<b64url payload>.<b64url sig>`, key = SESSION_SECRET) are accepted; the module throws at boot if SESSION_SECRET is unset.
**Why:** Unsigned/legacy base64 tokens and fallback signing keys are forgeable — both were flagged as critical auth bypasses in review. Users holding an old token just re-login once.
**How to apply:** Never re-add an unsigned-token acceptance path or a default signing key "for compatibility/dev convenience". Deployments must set SESSION_SECRET or the server refuses to start.

## Server-side write permissions

**Rule:** `requireModuleAction(module, action)` guards write endpoints. Level-1 hierarchy → always allow; no DB row for hierarchy+module → allow (default-open); explicit false → 403.
**Why:** Client `usePermission` defaults the OPPOSITE way (view-only when no row) — intentional asymmetry; the Permissions page save writes explicit rows for every module, closing the gap after first save.
**How to apply:** New write endpoints must be wrapped in `requireModuleAction` with a module name matching the Permissions page MODULE_GROUPS exactly (see permissions.md).

## Known gaps (proposed as follow-up tasks, not fixed)

- Tokens carry issuedAt but no TTL check — sessions never expire.
- Login lockout counters are in-memory: reset on restart, per-instance on autoscale.

**Why:** Running Neon migration scripts requires NODE_PATH=lib/db/node_modules:artifacts/api-server/node_modules because pg is in lib/db and bcryptjs is in api-server. Use a .cjs file (not .mjs) for standalone migration scripts.
