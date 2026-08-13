# Marlin ERP — UI Modernization Conventions (page-sweep contract)

This document is the **binding contract** for the page modernization sweep.
Every modernized page must follow it exactly. When a rule here conflicts with
your own taste, THIS DOCUMENT WINS.

## Prime directive — zero behavior change

This is a **visual** sweep. You must NOT change:

- Any API hook call, query key, mutation, or fetch parameter.
- Any calculation, rounding, currency formatting, GST/figure logic, totals.
  Money figures must be byte-identical before/after.
- Any permission gating (`perm.canX`, level checks, RoutePermissionGuard).
- Any form field, validation rule, submit payload, or dialog flow.
- Sorting/filtering/pagination logic (`useTableSort`, `useClientPage`,
  `TablePager`, `EntityCombobox` stay exactly as wired).
- CSV export contents.
- Routes, file names, component names, exported symbols.

You must NOT edit these shared files (read-only for you):
`src/components/app/*`, `src/components/ui/*`, `src/index.css`, `src/App.tsx`,
`src/components/layout/AppLayout.tsx`, `src/lib/moduleRegistry.ts`, anything
under `lib/` at the workspace root.

Do not create new files, new routes, or new pages. Modernize in place.

## Page anatomy (top to bottom)

Every list/report page follows this order inside `<AppLayout>`:

1. `<PageHeader>` — title, one-line description, icon, primary actions on the right.
2. `<SummaryCardGrid>` with 2–4 `<SummaryCard>`s — ONLY figures already
   derivable from data the page already fetches. Never add endpoints, never
   invent analytics. If the page has no natural summary, skip the cards.
3. Toolbar row: search `<Input>` (with `Search` icon) on the LEFT, then
   `<FilterPanel>` (if the page has 2+ filters) or inline selects on the RIGHT.
4. The table, inside `bg-card border border-border rounded-xl shadow-sm overflow-hidden`.
5. `TablePager` (unchanged) / footer totals row (unchanged).

Detail/entry pages: `<PageHeader>` + existing content restyled to match tokens.
Keyboard-entry forms (`keyboard-entry.tsx` conventions): do NOT restructure the
entry grid or its focus order — only page furniture around it.

## The component kit (`@/components/app/...`)

```tsx
import { PageHeader } from '@/components/app/page-header';
// <PageHeader title="Purchases" description="Vendor bills and goods inward" icon={ShoppingCart} actions={<Button…/>} />

import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
// <SummaryCardGrid>
//   <SummaryCard label="Total Outstanding" value={inr(total)} icon={Wallet} tone="warning" loading={isLoading} />
// </SummaryCardGrid>
// tone: 'default' | 'positive' | 'negative' | 'warning' | 'info'
// `value` must be pre-formatted by the page's EXISTING formatter (₹ rules stay put).

import { StatusBadge } from '@/components/app/status-badge';
// <StatusBadge status={row.status} />  — replaces ad-hoc per-page status color maps.
// Knows: paid/partial/unpaid/draft/approved/cancelled/dispatched/in_transit/active/expired/….
// Unknown statuses render neutral gray with the raw text — safe for any string.

import { EmptyState } from '@/components/app/empty-state';
// <EmptyState icon={FileX} title="No purchases yet" hint="Record your first vendor bill." action={<Button…/>} />
// In a table: <TableCell colSpan={n} className="p-0"><EmptyState … compact /></TableCell>

import { TableSkeleton, SummaryCardsSkeleton } from '@/components/app/loading-skeletons';
// while isLoading: <TableSkeleton rows={8} cols={6} />

import { FilterPanel } from '@/components/app/filter-panel';
// <FilterPanel activeCount={n} onClear={reset}> …selects/date pickers… </FilterPanel>
// Use when a page has 2+ filters; keep the search input OUTSIDE the panel.
```

## Visual rules

- Only token classes: `bg-card`, `bg-muted/…`, `text-muted-foreground`,
  `border-border`, `text-primary`, `bg-primary/10`. NEVER hardcoded hex,
  `bg-white`, `text-black`, or `gray-###` for chrome. (Semantic accent colors
  like `text-emerald-600`/`text-red-600` for money signs stay as they are.)
- Cards: `rounded-xl border border-border bg-card shadow-sm`.
- Numbers in tables: `font-mono text-sm` right-aligned; keep existing formatters.
- Icons: lucide only, `w-4 h-4` in buttons/headers. No emojis anywhere.
- Keep the existing responsive patterns: `md:hidden` card lists next to
  `hidden md:block` tables must survive; touch-size bumps live in ui/ primitives.
- Buttons: primary action = default variant; secondary = `outline`; destructive
  = `destructive`. Icon-only buttons need `title=`.
- Dialogs: keep shadcn `Dialog` structure; `DialogDescription` for one-line context.
- Toasts: `sonner` only (`toast.success/error`) — never `use-toast`.
- shadcn `FormItem`/`FormLabel` ONLY inside a `FormField` render prop — plain
  `<label>` for non-RHF controls (violations crash the route at runtime).

## Pagination & entity pickers (apply while restyling)

- Every list/table page paginates. Client-paged full fetches use the shared
  `TablePager` + `useClientPage` (`components/ui/table-pager.tsx`); pages with
  server-paged hooks pass a `pageSize` state instead. If the page you are
  restyling has an unpaginated list, ADD the pager as part of the pass.
- Pagination applies AFTER filtering and sorting. Footer totals and CSV
  exports read the FULL filtered set, never just the visible page.
- Plain `<Select>` pickers over entity lists (accounts, ledgers, employees,
  customers, vendors, items, materials) become `EntityCombobox`
  (`components/ui/entity-combobox.tsx` — cmdk searchable, `{id,label,sublabel}`
  options, clearable, 200-row cap). Do not convert small enum selects
  (payment mode, status, month).
- These are furniture changes: never alter what data is fetched or how rows
  are filtered/computed.

## Transaction dialogs (dialog safety — binding for ALL dialog work)

Any dialog that records or edits a business document (sale, quotation,
purchase, receipt/payment/journal voucher, production batch, stock entry —
anything a user types money or line items into) uses the shared wrapper in
`components/ui/transaction-dialog.tsx`, never a raw `<Dialog>`:

```tsx
<TransactionDialog open={isOpen} dirty={form.formState.isDirty} onOpenChange={...}>
  <TransactionDialogContent className="sm:max-w-3xl">
    ...unchanged body...
    <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
  </TransactionDialogContent>
</TransactionDialog>
```

Behavior it guarantees (do not re-implement per page):
- While `dirty`, clicking outside the dialog does NOTHING (the accidental
  path is silently ignored — no popup spam).
- While `dirty`, Escape / the ✕ button / a `DialogClose`-wrapped Cancel show
  a "Discard unsaved changes?" confirmation; only Discard closes.
- A clean form closes like a normal dialog. Programmatic closes after a
  successful save (`setIsOpen(false)`) bypass the guard by construction.

Dirty convention:
- react-hook-form pages pass `form.formState.isDirty`, OR-ing any prefill
  flag that `form.reset(...)` hides (e.g. Sales' convert-from-quotation).
- Manual-state forms compute a boolean by comparing each field with the
  value it was initialized from (see `accounts/Journal.tsx`, `Vouchers.tsx`).
- Cancel buttons are wrapped in `<DialogClose asChild>` — never
  `onClick={() => setIsOpen(false)}`, which would skip the guard.

Responsive contract (baked into `TransactionDialogContent`):
- Phones: near-fullscreen (viewport minus a small inset).
- Desktop: unchanged — pages set width via `sm:max-w-*` ONLY (no bare
  `max-w-*`, which would break the mobile fullscreen); height is capped with
  internal vertical scrolling.
- No horizontal scrolling ever; long item/ledger names wrap (`break-words`
  is on the content — don't add `whitespace-nowrap` to name cells).

Coverage & recorded exceptions:
- Converted (money/stock document entry): Sales, Quotations, Purchases,
  Receipt, Payment, Journal, Vouchers (contra/notes quick-entry), Contra,
  Credit/Debit Notes, Production batches, Move Stock (storage placements),
  Expenses (accounts + sales), Returns, Sales cash balance, Cash-in-outlet
  deposit + reconcile, Collect Payment (customers + outstanding), Asset
  purchases/register/transfers/disposal, HR Advances (new/recover/edit),
  Payroll (edit/pay/advance), Rent payment.
- **Stock Transfer screens (`Transfers.tsx`) are an explicit, owner-approved
  exception** — the owner deferred all Stock Transfer UI changes; do not
  convert them until that module's own task lifts the deferral.
- Deliberately raw (not business-document entry): master-data forms
  (items, parties, warehouses, employees, ledgers, prices, coupons…),
  delete/approve/confirm prompts, read-only detail viewers, and workflow
  wizards (import, backup/restore, renumbering, reconciliation batch match,
  period locks, stock verification detail). New master forms MAY adopt the
  wrapper, but it is only mandatory for transaction entry.

## Currency format (the ONE money format)

Every money figure renders as `₹1,23,456.00` — Indian digit grouping
(`en-IN`), exactly two decimals. The shared formatter is `inr()` from
`@/lib/currency`; new and modernized surfaces must import it instead of
hand-rolling `toLocaleString`/`toFixed` variants. Legacy pages carry local
`inr()` helpers with byte-identical output — fold them into the import as
each module is modernized (never as a drive-by on a page you aren't
otherwise touching; money figures must stay byte-identical in a sweep).
PDFs keep `Rs.`-prefixed `pdfMoney` where jsPDF's WinAnsi fonts can't
render `₹` (see `pdf-unicode-fonts`).

## Verification (mandatory before you report done)

1. `cd artifacts/marlin-erp && npx tsc --noEmit` → must pass clean.
2. Re-read your diff: confirm no hook, query key, calculation, permission,
   or payload changed.
3. Report per page: what you modernized + explicit "logic untouched" confirmation.
