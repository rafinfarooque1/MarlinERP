/**
 * Enterprise-grade column sorting for data tables (Excel/Tally/SAP-style).
 *
 * - Click a header: ascending → descending → back to default order.
 * - Whole rows move together; sorting is applied to the already-filtered
 *   array, so filters/search are always preserved.
 * - Type-aware comparison: numbers numerically, dates chronologically,
 *   strings alphabetically with NATURAL numeric ordering
 *   (INV0002 < INV0009 < INV0010), blanks always last in either direction.
 *
 * Usage:
 *   const { sorted, sort } = useTableSort(filtered, {
 *     date:    r => r.saleDate,          // raw ISO string or Date
 *     invoice: r => r.invoiceNumber,
 *     total:   r => Number(r.totalAmount), // raw number, never a ₹-formatted string
 *   });
 *   ...
 *   <SortableHead k="date" sort={sort}>Date</SortableHead>
 *   ...
 *   {sorted.map(row => ...)}
 *
 * Accessors MUST return raw values (numbers, ISO date strings, plain text) —
 * never display-formatted strings like "₹1,234.56" or "04/08/2026".
 */
import { useMemo, useRef, useState, useCallback, type ReactNode, type ThHTMLAttributes } from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortDir = 'asc' | 'desc';

export interface SortHandle {
  /** Active column key, or null when the table is in its default order. */
  key: string | null;
  dir: SortDir | null;
  toggle: (key: string) => void;
}

// Natural ordering: "INV0009" < "INV0010", case-insensitive.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const NUMERIC_RE = /^-?(?:\d+|\d{1,3}(?:,\d{2,3})+)(?:\.\d+)?$/;

/** Normalize a raw cell value into something comparable. */
function rank(v: unknown): number | string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? null : t; }
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (s === '' || s === '—' || s === '-') return null;
  // Plain numeric strings (incl. Indian-grouped "1,23,456.78") compare as numbers
  if (NUMERIC_RE.test(s)) return Number(s.replace(/,/g, ''));
  return s;
}

/** Compare two normalized non-null values. */
function compareRanked(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Mixed number/string columns: numbers group before text (Excel behavior)
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return collator.compare(a, b);
}

/**
 * Sort rows by an accessor. Stable; blanks always sink to the bottom
 * regardless of direction (Excel behavior). Returns a NEW array.
 */
export function sortRows<T>(rows: readonly T[], accessor: (row: T) => unknown, dir: SortDir): T[] {
  const mult = dir === 'asc' ? 1 : -1;
  // Decorate–sort–undecorate: compute each key once (fast for large lists)
  const decorated = rows.map((row, i) => ({ row, i, key: rank(accessor(row)) }));
  decorated.sort((a, b) => {
    if (a.key === null || b.key === null) {
      if (a.key === null && b.key === null) return a.i - b.i;
      return a.key === null ? 1 : -1; // blanks last in BOTH directions
    }
    const c = compareRanked(a.key, b.key);
    if (c !== 0) return c * mult;
    return a.i - b.i; // stable
  });
  return decorated.map(d => d.row);
}

/**
 * Tri-state sortable table hook. `accessors` maps column keys to raw-value
 * getters. Third click on the same header restores the default order
 * (the incoming `rows` order — filters/search upstream are untouched).
 *
 * NOTE: accessor functions are read through a ref, so they should derive
 * values from the row itself, not from other component state.
 */
export function useTableSort<T>(
  rows: readonly T[],
  accessors: Record<string, (row: T) => unknown>,
): { sorted: T[]; sort: SortHandle } {
  const [state, setState] = useState<{ key: string; dir: SortDir } | null>(null);
  const accRef = useRef(accessors);
  accRef.current = accessors;

  const toggle = useCallback((key: string) => {
    setState(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click → default ERP order
    });
  }, []);

  const sorted = useMemo(() => {
    if (!state) return rows as T[];
    const acc = accRef.current[state.key];
    if (!acc) return rows as T[];
    return sortRows(rows, acc, state.dir);
  }, [rows, state]);

  const sort = useMemo<SortHandle>(
    () => ({ key: state?.key ?? null, dir: state?.dir ?? null, toggle }),
    [state, toggle],
  );

  return { sorted, sort };
}

/**
 * Clickable header cell. Drop-in replacement for <TableHead>.
 * Shows ▲/▼ on the active column only; inactive sortable columns get a
 * faint affordance icon. Alignment classes (text-right etc.) pass through.
 */
export function SortableHead({
  k, sort, children, className, ...props
}: { k: string; sort: SortHandle; children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  const active = sort.key === k;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => sort.toggle(k)}
      className={cn('cursor-pointer select-none hover:text-foreground transition-colors', className)}
      {...props}
    >
      <span className="inline-flex items-center gap-1 align-middle">
        <span>{children}</span>
        {active
          ? (sort.dir === 'asc'
            ? <ArrowUp className="w-3.5 h-3.5 shrink-0 text-primary" aria-hidden />
            : <ArrowDown className="w-3.5 h-3.5 shrink-0 text-primary" aria-hidden />)
          : <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-30" aria-hidden />}
      </span>
    </TableHead>
  );
}
