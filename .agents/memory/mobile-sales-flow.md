---
name: Mobile billing-flow lessons
description: Durable lessons from the employee-app New Sale wizard — fallback-bearing empty states, web-sync confirm dialogs vs submit locks, local-calendar business dates.
---

# Mobile billing-flow lessons

## A fallback-bearing empty state must be gated on RESOLVED queries
An empty option list that legitimately unlocks a weaker/legacy behavior (e.g. "no receiving accounts → plain-cash fallback") is indistinguishable from "queries still loading" when derived as `data ?? []`. Rendering the fallback before both source queries resolved lets a user on a slow connection take the legacy path a configured location should never see.
**Why:** loading-empty and resolved-empty have opposite meanings when emptiness grants a permission-like fallback.
**How to apply:** branch on `isLoading`/`isError` first and block progression until resolution; only a successful resolve may show the fallback. Same family as "permissive-default flags must fail closed on read errors" (guard-route-coverage.md).

## Web confirm dialogs are SYNCHRONOUS — defer retries past the submit lock
`lib/dialogs.ts` confirmDialog uses `window.confirm` on web, so `onConfirm` runs synchronously inside the original request's `.catch` — while the submit lock ref is still held — and an immediate retry is silently dropped. Native Alert is async and hides the bug.
**Why:** ref-based double-submit locks release in `.finally()` (a microtask); a synchronous confirm callback runs before that.
**How to apply:** confirmed retries go through `setTimeout(..., 0)` (macrotask, runs after the lock releases) and must reuse the same idempotency key/consent flags. Test the web build specifically — this failure records nothing and shows no error.

## Business dates come from the LOCAL calendar, never toISOString()
`new Date().toISOString().slice(0,10)` is the UTC date: in India every local time before 05:30 yields YESTERDAY, so "today" defaults, date arrows and range filters silently post/read the wrong accounting date for part of every day.
**How to apply:** use the local formatter/shifter in `employee-app/lib/localDate.ts` (or equivalent per-app helper) for any user-facing or payload date.

## E2e sale creation on the real-data dev DB
Successful sale creation permanently alters avg cost even after delete — UI e2e must exercise validation-failure paths only (assert zero POST /api/sales), with the server contract checked separately via rejection payloads that provably insert nothing.
