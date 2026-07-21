---
name: Marlin ERP Security Hardening
description: What was done, decisions made, and constraints to maintain for auth security
---

## What was implemented

- `reset-22d57e92.ts` deleted — this was an unauthenticated TRUNCATE ALL endpoint
- `artifacts/api-server/src/lib/password.ts` — PasswordService (bcryptjs, work factor 12)
- `artifacts/api-server/src/lib/passwordPolicy.ts` — validatePassword (8-char min), DEFAULT_INITIAL_PASSWORD='marlin1458'
- `artifacts/api-server/src/middleware/auth.ts` — requireAuth middleware + in-memory rate limiter (5 failures → 15 min lockout per username)
- `artifacts/api-server/src/routes/auth.ts` — full rewrite; no backdoor, bcrypt verify, rate limiting, audit log (LOGIN_SUCCESS/FAILED/LOGOUT/PASSWORD_CHANGED), mustChangePassword in responses
- `artifacts/api-server/src/app.ts` — global requireAuth middleware for all /api routes; exempts /health and POST /auth/login
- `artifacts/api-server/src/routes/hr.ts` — employees created with PasswordService.hash(DEFAULT_INITIAL_PASSWORD) + mustChangePassword:true; POST/GET/PATCH responses all include mustChangePassword; added POST /hr/employees/:id/reset-password endpoint
- `lib/db/src/schema/hr.ts` — mustChangePassword: boolean("must_change_password").notNull().default(false) added
- `lib/api-zod/src/generated/types/employee.ts` — mustChangePassword?: boolean added
- Frontend: Login.tsx redirects to /change-password if mustChangePassword; ChangePassword.tsx has forced-flow banner and clears flag on success; App.tsx AuthGuard checks mustChangePassword and redirects

## Credentials

- Dev + Neon prod admin: username=admin, password=marlin1458 (bcrypt $2b$12$), must_change_password=true
- New employees: initial password=marlin1458 (hashed), must_change_password=true (forced change on first login)
- Password reset endpoint: POST /api/hr/employees/:id/reset-password — resets to marlin1458 hash with must_change_password=true

## Invariants to maintain

**Why:** The startup migration in index.ts is idempotent — it only updates employees where password_hash NOT LIKE '$2%', so it won't overwrite passwords that employees have already changed.

**How to apply:** Never add a new migration that sets password_hash to a plaintext value. Always use PasswordService.hash() before any INSERT/UPDATE to the password_hash column.

**Why:** The global requireAuth middleware in app.ts exempts only `/health` and `POST /auth/login`. Adding new public endpoints requires adding explicit exemptions there.

**Why:** Running Neon migration scripts requires NODE_PATH=lib/db/node_modules:artifacts/api-server/node_modules because pg is in lib/db and bcryptjs is in api-server. Use a .cjs file (not .mjs) for standalone migration scripts.
