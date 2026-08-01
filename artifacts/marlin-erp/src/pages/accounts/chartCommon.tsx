/**
 * Shared vocabulary for the Chart of Accounts screens.
 *
 * The page renders three views of the same books — the account hierarchy, the
 * balance sheet and the profit & loss — so the money formatter, the Dr/Cr tag
 * and the statement payload shape live here rather than being duplicated or
 * imported across sibling files.
 */

import { useCallback, useRef, useState } from 'react';

/* ── types ──────────────────────────────────────────────────────────────────── */
export type ALType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

// `id` is only unique within a product kind — a finished good and a raw material
// can both be id 1 — so anything keying off a stock item must include the kind.
export interface StockItem { id: number; name: string; unit: string; stock: number; unitCost: number; total: number; materialType: string }

export interface LedgerNode {
  id: number; name: string; type: string; parentId: number | null;
  code: string | null; balance: number; isGroup?: boolean; children: LedgerNode[];
}

export interface GroupSummary {
  id: number | null; name: string; code: string | null; type?: string;
  total: number; children: LedgerNode[]; dutyAndTax?: number;
}

export interface FinancialStatements {
  filters: { warehouses: { id: number; name: string }[]; outlets: { id: number; name: string }[] };
  profitAndLoss: {
    expenses: {
      openingStock: number; openingStockItems: StockItem[];
      purchases: number;
      /** Debit-note total on the purchases subtree — `purchases` is already net of it. */
      purchaseReturns?: number;
      /** The Purchase group tree behind the single `purchases` figure. */
      purchasesGroup?: GroupSummary;
      directExpenses: GroupSummary; indirectExpenses: GroupSummary; total: number;
    };
    incomes: {
      sales: number;
      /** Gross sales and the credit-note total netted into `sales` (gross − returns = sales). */
      grossSales?: number;
      salesReturns?: number;
      /** The Sales group tree behind the single `sales` figure. */
      salesGroup?: GroupSummary;
      closingStock: number; closingStockItems: StockItem[];
      directIncomes: GroupSummary; indirectIncomes: GroupSummary; total: number;
    };
    /** Same engine figures the dashboard GP/NP tiles read — never recompute these. */
    summary?: { grossProfit: number; netProfit: number };
    netProfit: number;
  };
  balanceSheet: {
    liabilities: { capitalAccount: GroupSummary; loans: GroupSummary; currentLiabilities: GroupSummary; pandlCarryForward: number; difference: number; total: number };
    assets: { fixedAssets: GroupSummary; currentAssets: GroupSummary; closingStock: number; total: number };
  };
  integrity?: { balanced: boolean; difference: number; issues: string[] };
}

/** What the statement sheet needs to identify a ledger. */
export interface StatementTarget { id: number; name: string; code: string | null }

/* ── helpers ─────────────────────────────────────────────────────────────────── */
export const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);

/**
 * Which side an account normally sits on.
 *
 * The statements payload signs every figure so that a healthy balance is
 * POSITIVE — a liability of 384.62 Cr arrives as +384.62, not −384.62. Reading
 * the sign alone therefore labels every liability, capital and income account
 * "Dr", which is exactly backwards, so the natural side has to come from the
 * account's type.
 */
export const naturalSide = (type?: string | null): 'dr' | 'cr' =>
  type === 'liability' || type === 'equity' || type === 'income' ? 'cr' : 'dr';

/* ── statement expansion ─────────────────────────────────────────────────────
 * The Balance Sheet and the P&L render the same accounts from the same payload,
 * so a node id can appear in both. Expansion state is therefore keyed by
 * `${statement}:${id}` — collapsing "Current Assets" on the Balance Sheet must
 * not reach across and collapse anything on the P&L.
 *
 * The set holds the nodes that are OPEN, so the default (empty set) is
 * "top-level group heads visible, everything inside them collapsed" — the user
 * sees the statement's shape and its totals without every ledger at once.
 * Collapsing hides rows only; no figure is recomputed anywhere.
 */
export interface StatementExpansion {
  isOpen: (id: number) => boolean;
  toggle: (id: number) => void;
  expandAll: (ids: number[]) => void;
  collapseAll: () => void;
}

export function useStatementExpansion(statement: string): StatementExpansion {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const statementRef = useRef(statement);
  statementRef.current = statement;

  const key = useCallback((id: number) => `${statementRef.current}:${id}`, []);

  const isOpen = useCallback((id: number) => open.has(key(id)), [open, key]);

  const toggle = useCallback((id: number) => {
    setOpen(prev => {
      const next = new Set(prev);
      const k = key(id);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, [key]);

  const expandAll = useCallback((ids: number[]) => {
    setOpen(new Set(ids.map(key)));
  }, [key]);

  const collapseAll = useCallback(() => setOpen(new Set()), []);

  return { isOpen, toggle, expandAll, collapseAll };
}

/**
 * Every node in these groups that actually has children — the exact set
 * "Expand All" needs. Taken from the real children arrays, so a node without
 * children never becomes expandable and never grows a dead chevron.
 */
export function collectExpandableIds(groups: (GroupSummary | undefined)[]): number[] {
  const out: number[] = [];
  const walk = (n: LedgerNode) => {
    if (n.children && n.children.length > 0) {
      out.push(n.id);
      n.children.forEach(walk);
    }
  };
  for (const g of groups) {
    if (!g) continue;
    if (g.id != null && g.children.length > 0) out.push(g.id);
    g.children?.forEach(walk);
  }
  return out;
}

/** Inline balance tag — always renders, shows Dr/Cr suffix with colour. */
export function BalTag({ balance, size = 'sm', natural = 'dr' }: {
  balance: number; size?: 'sm' | 'xs';
  /** The side a positive balance belongs on — see naturalSide(). */
  natural?: 'dr' | 'cr';
}) {
  const fs  = size === 'sm' ? 'text-[12px]' : 'text-[11px]';
  const tag = size === 'sm' ? 'text-[10px]' : 'text-[9px]';
  if (balance === 0)
    return <span className={`${fs} font-mono tabular-nums text-muted-foreground/35 shrink-0`}>—</span>;
  const dr = natural === 'dr' ? balance > 0 : balance < 0;
  return (
    <span className={`${fs} font-mono tabular-nums shrink-0 ${dr ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
      {fmt(Math.abs(balance))}<span className={`${tag} ml-0.5 opacity-70`}>{dr ? 'Dr' : 'Cr'}</span>
    </span>
  );
}
