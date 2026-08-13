---
name: Transaction dialog guard
description: Shared TransactionDialog wrapper conventions — dirty guard, DialogClose rule, sizing, scope exceptions
---

# TransactionDialog guard (binding for all ERP dialog work)

Every money/stock **document-entry** dialog uses `components/ui/transaction-dialog.tsx`
(`TransactionDialog` + `TransactionDialogContent`), never raw `<Dialog>`. Full contract in
`artifacts/marlin-erp/docs/UI_CONVENTIONS.md` (coverage list + exceptions recorded there).

Rules that reviewers enforce strictly:
- **Every visible close path must go through the guard.** Wrap Cancel AND "Close" footer
  buttons in `<DialogClose asChild>`; any `onClick={() => setOpen(false)}` bypasses the
  dirty confirm and gets a task rejected. Programmatic close after successful save is the
  only legitimate direct close.
- Width via `sm:max-w-*` ONLY — a bare `max-w-*` breaks mobile near-fullscreen.
- Dirty: RHF forms pass `form.formState.isDirty`; manual-state forms compare each field
  against its seed value (including prefilled amounts, e.g. `amount !== String(item.balanceDue ?? '')`).
- Delete/approve confirms, master-data forms, read-only viewers, workflow wizards stay raw
  (documented convention scope). Stock Transfer screens (`Transfers.tsx`) are an
  owner-approved exception — do not convert until that module's own task lifts it.

**Why:** dialogs closing on outside-click/Escape lost typed transaction data; the guard is
the Phase-3 foundation all later UI tasks build on. Currency on these surfaces uses shared
`inr()` from `lib/currency.ts` (₹ en-IN, fixed 2dp) — local `fmt`/`inr` consts delegate to it.
