/**
 * Shared vocabulary for the Chart of Accounts screens.
 *
 * The page renders three views of the same books — the account hierarchy, the
 * balance sheet and the profit & loss — so the money formatter, the Dr/Cr tag
 * and the statement payload shape live here rather than being duplicated or
 * imported across sibling files.
 */

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
      /** The Purchase group tree behind the single `purchases` figure. */
      purchasesGroup?: GroupSummary;
      directExpenses: GroupSummary; indirectExpenses: GroupSummary; total: number;
    };
    incomes: {
      sales: number;
      /** The Sales group tree behind the single `sales` figure. */
      salesGroup?: GroupSummary;
      closingStock: number; closingStockItems: StockItem[];
      directIncomes: GroupSummary; indirectIncomes: GroupSummary; total: number;
    };
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
