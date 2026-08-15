/**
 * Transaction Window — the ONE layout vocabulary for transaction entry
 * surfaces. The MASTER design is the Purchase → New Purchase Bill page;
 * POS "Record Sale" and "New Quotation" reuse these exact primitives so all
 * three read as a single system (docs/UI_CONVENTIONS.md → "Transaction
 * windows"). Pure presentation — no business logic lives here, and changing
 * a class here restyles every transaction window at once, deliberately.
 *
 * Layout contract (from the Purchase master):
 *  - A vertical stack of section cards: header fields → line items →
 *    other charges → (notes +) summary, with the running total and the
 *    action buttons pinned in a bar at the bottom.
 *  - Line items render as a real table ≥lg (one shared grid template for the
 *    header strip and every row so columns can never drift), and wrap into
 *    small labelled cells below lg — NO horizontal scrolling at any width.
 *  - Long item names wrap; text sizes never shrink below the master's.
 */
import * as React from 'react';

/** Section card — every major block sits in one of these. */
export const TXN_CARD = 'bg-card border border-border rounded-xl shadow-sm p-4 sm:p-6';

/** Header-field grid inside the first card (3 columns on desktop). */
export const TXN_HEADER_GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start';

/** Bordered container around the line-item table. */
export const TXN_LINES_BOX = 'border border-border rounded-lg overflow-hidden';

/** Column-header strip, shown ≥lg only — pass the page's lg grid template. */
export const txnLinesHead = (gridLg: string) =>
  `hidden lg:grid gap-2 bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide px-3 py-2.5 ${gridLg}`;

/** One line row — a table row ≥lg, labelled wrapped cells below. The grid
 *  template string MUST be the same one given to txnLinesHead. */
export const txnLineRow = (gridLg: string) =>
  `grid items-end lg:items-center gap-2 px-3 py-2.5 border-t border-border grid-cols-2 sm:grid-cols-4 ${gridLg}`;

/** Tinted sub-strip under a line row (batch dates on purchases; per-line GST
 *  breakdown on sales/quotations). Wraps naturally on narrow screens. */
export const TXN_SUBROW = 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-1.5 bg-emerald-500/[0.03]';

/** Tiny label above each cell below lg, where the header strip is hidden.
 *  Plain <span>, not FormLabel — these cells are often register()-driven. */
export const TxnCellLabel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span className={`lg:hidden text-[10px] uppercase tracking-wide text-muted-foreground font-medium ${className}`}>{children}</span>
);

/** Bottom pairing: notes (or nothing) on the left, the summary card on the
 *  right — the summary always occupies the right half on desktop. */
export const TXN_BOTTOM_GRID = 'grid grid-cols-1 md:grid-cols-2 gap-6';

/** Summary card body — plain label/value rows inside a section card. */
export const TXN_SUMMARY_CARD = `${TXN_CARD} space-y-2 text-sm`;

/** Sticky action bar (running total left, Cancel + Save right).
 *  Page flavour fixes to the viewport (the Purchase page pairs it with a
 *  pb-24 on the stack); the dialog flavour sticks to the dialog's own scroll
 *  box — negative margins bleed it to the dialog edges. */
export const TXN_ACTION_BAR_PAGE = 'fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 backdrop-blur';
export const TXN_ACTION_BAR_DIALOG = 'sticky bottom-0 z-20 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 border-t border-border bg-background/95 backdrop-blur';
export const TXN_ACTION_BAR_INNER = 'flex items-center justify-between gap-3 px-4 py-2.5 md:px-8';
export const TXN_ACTION_BAR_INNER_DIALOG = 'flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2.5';
