---
name: Mobile ERP foundation (employee app)
description: Session/permission/location conventions for the Expo employee app's ERP expansion — cache isolation at session boundaries, startup refresh of persisted identity, server-scoped location pref, nav gating, self-scope 403 gap.
---

# Mobile ERP foundation

## Session boundaries must reset cache + location snapshot synchronously
Every login, logout, and confirmed 401 must clear BOTH the React Query cache and the module-level location header snapshot before new session state lands.
**Why:** query keys are global (not per-user) and location headers ride outside query keys — without the reset, the next account on the same device can render the previous user's cached data or fire its first requests with the previous user's warehouse headers. The leak is a race, invisible to happy-path e2e tests.
**How to apply:** one shared reset routine owned by the auth layer, used by all three paths. Keep the header snapshot in its own tiny module so auth can clear it without a circular import with the location provider.

## Persisted identity must be refreshed from the server on startup
A stored employee record written by an older app version can lack fields the current code treats as required (hierarchy, branch). On app start with a persisted token, fetch `/auth/me` and replace the stored record before permission or location logic runs; fail closed to login on server rejection. Offline starts may reuse the stored record ONLY if it already has the current shape.
**Why:** deserializing old-shape records silently denies all ERP navigation and pins branch users to an undefined location — it breaks precisely the users who upgrade with a live session.

## Location preference is per-user and server-persisted
A Head Office user's selected location restores from `employee.uiLocationPref` and persists via `PUT /auth/location-pref` — the same per-user server preference the web sidebar uses. Never a device-global store.
**Why:** a device-global key hands the previous user's selected warehouse to the next account on a shared phone.

## Navigation gating conventions
- Tab shape is decided by the same permission resolution as the web app (level-1 bypass, default-deny, any-of page keys). While permissions load, show the plain-employee shape — deny-first, no ERP flash.
- Branch (warehouse/outlet) users are pinned to their login branch: static location label, setLocation no-ops. Only warehouse/outlet selections send x-location headers (mirrors web); HO/All send none.
- Automatic location transitions (pin on login, restore of a pref) must invalidate queries when they change the effective header signature — not just picker-driven changes.

## Self-service HR endpoints still 403 for non-HR hierarchies
`GET /hr/payroll` and `GET /hr/leave-balance` return 403 for employees whose hierarchy lacks the HR page rights — unlike `/hr/advances`, which self-scopes. Pre-existing server behavior; on mobile it silently empties the payslip/leave tiles for such users. Fix direction: self-scope like advances (see session-401-contract.md).

## Expo e2e note
A `ReferenceError` for a symbol that greps clean in source = stale Metro HMR bundle in a long-lived tester browser; a fresh page load clears it.

## E2E testing the Expo app
Testers must open `https://$REPLIT_EXPO_DEV_DOMAIN/` directly. A path like `/employee-app/` on the shared
proxy hits the WEB app's Vite server, which answers with its own HTML — the tester then sees a blank screen
and misreads it as a Metro bundle failure. Also: a workflow restart mid-test leaves Metro cold; the first
bundle takes 1–2 min, so tell the tester to wait, not restart.
