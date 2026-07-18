---
name: API client hook names
description: Actual exported hook names from lib/api-client-react — many intuitive names don't exist; use this before writing new pages.
---

## Key hook names that differ from intuition

| What you'd guess | Actual hook |
|---|---|
| `useUpsertItemPrice` | `useSetItemPrice` |
| `useMarkAttendance` | `useCheckIn` / `useCheckOut` (two separate hooks) |
| `useListAccountLedgers` | `useListChartOfAccounts` |
| `getListAccountLedgersQueryKey` | `getListChartOfAccountsQueryKey` |
| `useGetCompanyProfile` | `useGetCompanySettings` |
| `useUpdateCompanyProfile` | `useUpdateCompanySettings` |

## Hooks that do NOT exist (create-only APIs)

These entities only have `useList*`, `useCreate*`, and `useGet*` — no update or delete:
- Hierarchy: `useCreateHierarchy` only (no update/delete)
- Employee: `useCreateEmployee` only
- Customer: `useCreateCustomer` only
- Vendor: `useCreateVendor` only
- Coupon: `useCreateCoupon` only

**Why:** The generated API client is derived from the OpenAPI spec. The backend only exposes POST endpoints for these resources (no PUT/PATCH/DELETE). Pages for these entities should be create+view-only.

**How to apply:** Before using any hook, grep `lib/api-client-react/src/generated/api.ts` for the exact export name. Never assume a hook exists — the generated file is the source of truth.

## Attendance split hooks

Attendance mark-in/out uses two separate mutations:
- `useCheckIn({ data: { employeeId, timestamp } })` 
- `useCheckOut({ data: { employeeId, timestamp } })`
