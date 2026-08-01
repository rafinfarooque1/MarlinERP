---
name: Shared endpoints behind multiple page keys
description: What to widen (and what to bind) when a second page surface reuses an existing module's endpoints
---

When a new sidebar page reuses another module's endpoints (e.g. Operations › Receipt/Payment Voucher over the Accounts vouchers engine), `requireModuleView`/`requireModuleAction` accept an any-of ARRAY of page keys. Three rules:

1. **Widen every endpoint the page touches, not just the writes.** The form's lookup GETs (`/accounts/chart/flat`, `/accounts/cash-bank-ledgers`) are guarded too — a role granted only the new page key passes the write guards but gets 403 on the dropdowns and can't fill the form. Trace the page's full request set.

2. **Bind any-of guards to the request's kind.** A shared route serving two separately-permissioned kinds (one PDF endpoint for receipt AND payment) must pick the required key FROM the validated request kind, not list both keys — otherwise a receipt-only role prints payments. Pattern: validate `kind` in a wrapper middleware, then call `requireModuleAction(["<override key>", kindKey], action)(req, res, next)`.

3. **Seed the new page keys** (default-deny RBAC): one-time boot block granting all-true rows to pre-existing `level != 1` hierarchies, guarded by a `migration_log` name with `ON CONFLICT (name) DO NOTHING` (name is the PK — makes concurrent replica boots safe). Then regenerate `pagePermissions.ts` via `pnpm --filter @workspace/scripts run permissions:write` (it is GENERATED from moduleRegistry.ts — never hand-edit).

**Why:** all three failure modes shipped or were caught in review when the Operations voucher pages were added (Aug 2026).
