/**
 * The single source of truth for the financial statements.
 *
 * Everything here derives from `buildDerivedPostings()` — the same balanced
 * double-entry stream the Trial Balance, Cash Book and Bank Book already read.
 * Before this module the P&L summed the `sales` and `purchases` tables directly
 * and read journal vouchers only for one subtree, so a journal entry to Sales
 * never reached the statement, revenue was reported gross of GST, and the
 * Balance Sheet needed a six-figure plug line to appear to balance.
 *
 * Two rules make the statements balance by construction rather than by plug:
 *
 *  1. Every posting is balanced (debits = credits), so summing them across all
 *     ledgers gives zero. Split that sum into balance-sheet and P&L ledgers and
 *     you get Assets = Liabilities + Profit exactly. Any residual is therefore a
 *     real defect — a posting to a deleted ledger, a ledger hanging off no root,
 *     or opening balances that do not themselves balance — and is reported as
 *     an error instead of being absorbed.
 *
 *  2. Inventory is periodic, not perpetual. Purchases are expensed and stock is
 *     brought in through opening/closing stock, valued once by
 *     `stockValuation()`. Production costing bolts a perpetual overlay on top
 *     (Dr Finished Goods Inventory / Cr Production Cost Absorbed); counting
 *     both would double the stock. The overlay is a matched Dr/Cr pair of equal
 *     value, so removing both legs keeps the books balanced and leaves one
 *     inventory figure. The pair is checked, not assumed.
 */

import { pool } from "@workspace/db";
import { closingStockValuation, stockValuation, resolveProductNames, type ValuedItem } from "./valuation";
import { isIsoDate } from "./dateInput";

const r2 = (n: number) => Math.round(n * 100) / 100;
// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDate = (s: unknown): s is string => isIsoDate(s);

/** Day before an ISO date, for "as at the start of the period" reads. */
export function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Today in the server's local calendar. Deliberately not `toISOString()`, which
 * shifts the date westward of UTC and would make an evening request read as
 * tomorrow — enough to flip a statement between "current" and "historical".
 */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Chart of accounts ──────────────────────────────────────────────────────

/** Root system groups that make up the profit & loss account. */
export const PL_INCOME_ROOTS = ["SYS-SAL", "SYS-DIRINC", "SYS-INDINC"] as const;
export const PL_EXPENSE_ROOTS = ["SYS-PUR", "SYS-DIREXP", "SYS-INDEXP"] as const;
/** Root system groups that make up the balance sheet. */
export const BS_LIABILITY_ROOTS = ["SYS-CAP", "SYS-LOAN", "SYS-CURL"] as const;
export const BS_ASSET_ROOTS = ["SYS-FIXD", "SYS-CURA", "SYS-OPSTOCK", "SYS-CLSTOCK"] as const;

/**
 * The perpetual-inventory overlay written by production costing. Both legs are
 * excluded from the statements: closing stock already carries manufactured
 * value, and the pair nets to zero so removing it cannot unbalance anything.
 */
export const CAPITALISATION_LEDGERS = ["STD-FG-INV", "STD-PROD-ABS"] as const;

export interface ChartRow {
  id: number;
  code: string | null;
  name: string;
  type: string;
  parentId: number | null;
  isGroup: boolean;
  isSystemGroup: boolean;
}

export interface ChartNode extends ChartRow {
  children: ChartNode[];
  /** Own (non-inherited) net debit, positive = debit. */
  balance: number;
}

export interface Chart {
  rows: ChartRow[];
  byId: Map<number, ChartNode>;
  byCode: Map<string, ChartNode>;
  roots: ChartNode[];
  /** Code of the top-most ancestor of a ledger, or null when it does not exist. */
  rootCodeOf(id: number): string | null;
  /** A ledger plus every descendant. */
  subtree(id: number): Set<number>;
  /** Ids at or under the given root codes. */
  idsUnder(codes: readonly string[]): Set<number>;
}

export async function loadChart(): Promise<Chart> {
  const { rows } = await pool.query(
    `SELECT id, code, name, type, parent_id, is_group, is_system_group
       FROM account_ledgers ORDER BY id`,
  );
  const chartRows: ChartRow[] = rows.map((r: any) => ({
    id: Number(r.id),
    code: r.code ?? null,
    name: r.name ?? "",
    type: r.type ?? "",
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    isGroup: !!r.is_group,
    isSystemGroup: !!r.is_system_group,
  }));

  const byId = new Map<number, ChartNode>();
  for (const r of chartRows) byId.set(r.id, { ...r, children: [], balance: 0 });
  const byCode = new Map<string, ChartNode>();
  const roots: ChartNode[] = [];
  for (const node of byId.values()) {
    if (node.code) byCode.set(node.code, node);
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const rootCache = new Map<number, string | null>();
  const rootCodeOf = (id: number): string | null => {
    if (rootCache.has(id)) return rootCache.get(id)!;
    let cur = byId.get(id);
    // Depth guard: a cycle in parent_id would otherwise spin forever.
    for (let hops = 0; cur && cur.parentId != null && hops < 32; hops++) {
      const next = byId.get(cur.parentId);
      if (!next) break;
      cur = next;
    }
    const code = cur ? cur.code : null;
    rootCache.set(id, code);
    return code;
  };

  const subtree = (id: number): Set<number> => {
    const out = new Set<number>();
    const walk = (n: ChartNode | undefined) => {
      if (!n || out.has(n.id)) return;
      out.add(n.id);
      for (const c of n.children) walk(c);
    };
    walk(byId.get(id));
    return out;
  };

  const idsUnder = (codes: readonly string[]): Set<number> => {
    const out = new Set<number>();
    for (const code of codes) {
      const node = byCode.get(code);
      if (!node) continue;
      for (const id of subtree(node.id)) out.add(id);
    }
    return out;
  };

  return { rows: chartRows, byId, byCode, roots, rootCodeOf, subtree, idsUnder };
}

// ── Opening / closing stock ────────────────────────────────────────────────

export interface StockAtDate {
  total: number;
  inTransit: number;
  items: ValuedItem[];
  /**
   * false when stock history cannot account for the movement between the
   * requested date and today, so the figure is a best estimate rather than a
   * fact. Surfaced on the statement instead of being hidden.
   */
  reliable: boolean;
  note: string | null;
}

/** Closing stock: every product kind, every location, in-transit included. */
export async function closingStockAt(): Promise<StockAtDate> {
  const v = await closingStockValuation(pool);
  return { total: v.total, inTransit: v.inTransit, items: v.items, reliable: true, note: null };
}

/**
 * The earliest business date on any document that can move stock.
 *
 * This is what proves "the business held nothing then" for a date before
 * trading began — a fact that survives the movement log being younger than the
 * data. Without it, every statement run for a normal financial year would flag
 * its own opening stock as unknowable, because the log cannot reach back to the
 * 1 April before trading started. Returns carry no business date of their own,
 * so they fall back to when they were recorded; they can only follow the sale
 * or purchase they reverse, so they never move the earliest date anyway.
 *
 * Every channel that can put stock on the books has to be in here, not just the
 * trading documents: a physical verification writes a counted quantity straight
 * into `stock_entries` and logs no movement at all, so omitting it would let a
 * date after real stock existed be reported as a confident zero.
 */
async function inceptionDate(): Promise<string | null> {
  const { rows: [r] } = await pool.query(
    `SELECT MIN(d)::date::text AS first_doc FROM (
       SELECT MIN(purchase_date)          AS d FROM purchases
       UNION ALL SELECT MIN(sale_date)             FROM sales
       UNION ALL SELECT MIN(production_date)       FROM productions
       UNION ALL SELECT MIN(transfer_date)         FROM stock_transfers
       UNION ALL SELECT MIN(verify_date::date)     FROM stock_verifications
       UNION ALL SELECT MIN(created_at)            FROM sales_returns
       UNION ALL SELECT MIN(created_at)            FROM purchase_returns
     ) x`,
  );
  return r?.first_doc ?? null;
}

/**
 * Stock as at the end of `asOf`, valued at cost.
 *
 * Quantity truth (`stock_entries`) holds only today's position, so the historic
 * quantity is today's quantity rewound through `stock_ledger` movements booked
 * after that date. That is exact only while the movement log is complete, so
 * completeness is checked per product+location and reported: `stock_ledger` was
 * added after the first stock existed, and rows written fire-and-forget can be
 * lost, either of which leaves the log short of the quantity truth.
 *
 * Cost is today's weighted-average cost — per-date cost history is not stored.
 */
export async function stockAsOf(asOf: string | null | undefined): Promise<StockAtDate> {
  if (!isDate(asOf)) {
    return { total: 0, inTransit: 0, items: [], reliable: true, note: null };
  }

  // Earliest movement ever recorded. On its own this does NOT mean the business
  // held nothing before it — `created_at` is when the row was written, not when
  // the goods moved, and the log was introduced after stock already existed. It
  // only means "nothing held" once the log is proven to explain today's
  // quantity, which is checked below.
  const [{ rows: [bounds] }, inception] = await Promise.all([
    pool.query(`SELECT MIN(created_at)::date::text AS first_move FROM stock_ledger`),
    inceptionDate(),
  ]);
  const firstMove: string | null = bounds?.first_move ?? null;

  // Before the business's first stock-moving document there was no stock. That
  // is a fact about the trading history, not an inference from the log, so it
  // holds even when the log is younger than the data.
  if (inception && asOf < inception) {
    return { total: 0, inTransit: 0, items: [], reliable: true, note: null };
  }

  // Movement after the as-at date, and total logged movement, per product+location.
  const { rows: moves } = await pool.query(
    `SELECT material_type, ref_id::int AS ref_id, branch_type, branch_id::int AS branch_id,
            COALESCE(SUM(qty_change::numeric) FILTER (WHERE COALESCE(txn_date, created_at::date) > $1::date), 0) AS after_qty,
            COALESCE(SUM(qty_change::numeric), 0) AS all_qty
       FROM stock_ledger
      GROUP BY 1, 2, 3, 4`,
    [asOf],
  );
  const afterByKey = new Map<string, number>();
  const loggedByKey = new Map<string, number>();
  for (const m of moves) {
    const key = `${m.material_type}:${m.ref_id}:${m.branch_type}:${m.branch_id}`;
    afterByKey.set(key, Number(m.after_qty));
    loggedByKey.set(key, Number(m.all_qty));
  }

  // Today's quantity for EVERY product+location line, read straight from the
  // quantity truth rather than through `stockValuation()`, which filters
  // `quantity > 0`. A line sitting at zero today is exactly the line a
  // historical statement must not miss — anything sold out, consumed or
  // transferred away since the as-at date reads zero now but held stock then.
  // Sourcing the rewind only from positive lines would drop it silently, and
  // because a dropped line is never reconciled either, the result would still
  // be reported as reliable.
  const { rows: onHand } = await pool.query(
    `SELECT material_type, item_id::int AS ref_id, branch_type, branch_id::int AS branch_id,
            quantity::numeric AS quantity
       FROM stock_entries`,
  );
  const todayByKey = new Map<string, number>();
  for (const r of onHand) {
    todayByKey.set(`${r.material_type}:${r.ref_id}:${r.branch_type}:${r.branch_id}`, Number(r.quantity));
  }

  // Every line either the quantity truth or the movement log knows about. The
  // log can name a product+location that has since lost its `stock_entries`
  // row, which is a zero baseline, not an absent one.
  const keys = new Set<string>([...todayByKey.keys(), ...loggedByKey.keys()]);

  const parseKey = (key: string) => {
    const [materialType, refId] = key.split(":");
    return { materialType: materialType as ValuedItem["materialType"], refId: Number(refId) };
  };
  // Cost comes from the product master, the same avg-cost-else-cost rule
  // `stockValuation()` applies, so both paths value a product identically.
  const meta = await resolveProductNames(pool, [...keys].map(parseKey));

  const byProduct = new Map<string, ValuedItem>();
  let total = 0;
  let unreconciled = 0;
  let unvalued = 0;

  for (const key of keys) {
    const todayQty = todayByKey.get(key) ?? 0;
    const logged = loggedByKey.get(key);
    // The log must explain today's quantity for the rewind to be exact.
    const explained = logged === undefined ? todayQty === 0 : Math.abs(logged - todayQty) <= 0.001;
    if (!explained) unreconciled += 1;

    const qty = Math.round((todayQty - (afterByKey.get(key) ?? 0)) * 1000) / 1000;
    if (qty <= 0) continue;

    const { materialType, refId } = parseKey(key);
    const info = meta.get(`${materialType}:${refId}`);
    // Stock we can prove was held but cannot value — the product master is gone
    // — must not be quietly valued at nothing.
    if (!info) { unvalued += 1; continue; }

    const value = r2(qty * info.unitCost);
    total = r2(total + value);
    const pk = `${materialType}:${refId}`;
    const prev = byProduct.get(pk);
    if (prev) {
      prev.stock = Math.round((prev.stock + qty) * 1000) / 1000;
      prev.total = r2(prev.total + value);
      prev.unitCost = prev.stock > 0 ? r2(prev.total / prev.stock) : info.unitCost;
    } else {
      byProduct.set(pk, {
        id: refId, name: info.name, unit: info.unit, stock: qty,
        unitCost: info.unitCost, total: value, materialType,
        typeLabel: materialType === "item" ? "Finished Good"
          : materialType === "material" ? "Raw Material" : "Packing Material",
      });
    }
  }

  // The rewind is only sound when the log explains today's quantity on every
  // line, because today's quantity is the starting point it rewinds from. A log
  // that falls short is younger than the stock (or has lost fire-and-forget
  // rows), so subtracting the movements it does hold from a total it never
  // accounted for lands on a confident-looking wrong number.
  //
  // Deliberately no "complete log, so a date before the first logged movement
  // must be zero" shortcut. Reconciliation compares *net* movement against
  // today's quantity, which unlogged movements that happen to cancel out would
  // also satisfy — that is not proof of a complete history, and a fabricated
  // zero reads as a fact. Where the log really is complete the rewind already
  // arrives at zero on its own arithmetic, so nothing is lost by not claiming it.
  const reasons: string[] = [];
  if (unreconciled > 0) {
    reasons.push(
      `movement history does not fully account for today's quantity on ${unreconciled} product/location line${unreconciled === 1 ? "" : "s"}` +
      (firstMove ? ` and only reaches back to ${firstMove}` : ""),
    );
  }
  if (unvalued > 0) {
    reasons.push(`${unvalued} line${unvalued === 1 ? "" : "s"} held stock on that date but the product record no longer exists, so it could not be valued`);
  }
  const complete = reasons.length === 0;

  return {
    total,
    inTransit: 0,
    items: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
    reliable: complete,
    note: complete ? null
      : `Stock ${reasons.join("; and ")}. The position on ${asOf} is therefore derived rather than recorded and should not be relied on.`,
  };
}

// ── Statement assembly ─────────────────────────────────────────────────────

/**
 * A closing position for a past date is rewound from `stock_ledger` rather than
 * read from `stock_entries`, and goods that were in transit on that date cannot
 * be recovered at all — a transfer records when it was dispatched but not when
 * it was received, so there is no way to tell which shipments were still in
 * flight. Saying so is better than quietly reporting a smaller number.
 */
const HISTORICAL_CLOSE_NOTE =
  "Closing stock for a past date is reconstructed from stock movement history and is valued at today's average cost. "
  + "Goods in transit on that date are excluded, because transfers record a dispatch date but no receipt date.";

export interface StatementNode {
  id: number;
  name: string;
  code: string | null;
  type: string;
  isGroup: boolean;
  isSystemGroup: boolean;
  /** Signed in the natural direction of the section: positive = expected side. */
  balance: number;
  children: StatementNode[];
}

export interface StatementGroup {
  id: number | null;
  name: string;
  code: string;
  type?: string;
  total: number;
  children: StatementNode[];
}

export interface BooksIntegrity {
  balanced: boolean;
  difference: number;
  issues: string[];
}

export interface OpeningBalanceSummary {
  debit: number;
  credit: number;
  balanced: boolean;
  lines: number;
}

interface LedgerAgg { dr: number; cr: number }

/** Signed net debit for a ledger's own postings. */
const netOf = (a: LedgerAgg | undefined) => (a ? r2(a.dr - a.cr) : 0);

export interface BooksOptions {
  fromDate?: string | null;
  toDate?: string | null;
}

export interface Books {
  period: { fromDate: string | null; toDate: string | null };
  profitAndLoss: {
    expenses: {
      openingStock: number;
      openingStockItems: ValuedItem[];
      openingStockReliable: boolean;
      openingStockNote: string | null;
      purchases: number;
      purchasesGroup: StatementGroup;
      directExpenses: StatementGroup;
      indirectExpenses: StatementGroup;
      total: number;
    };
    incomes: {
      sales: number;
      salesGroup: StatementGroup;
      closingStock: number;
      closingStockItems: ValuedItem[];
      closingStockInTransit: number;
      /** false when the closing position is rewound from history rather than read. */
      closingStockReliable: boolean;
      closingStockNote: string | null;
      directIncomes: StatementGroup;
      indirectIncomes: StatementGroup;
      total: number;
    };
    /** Vertical (Tally-style) restatement of the same figures. */
    summary: {
      revenue: number;
      costOfGoodsSold: number;
      grossProfit: number;
      grossMarginPct: number;
      otherIncome: number;
      operatingExpenses: number;
      netProfit: number;
      netMarginPct: number;
    };
    netProfit: number;
  };
  balanceSheet: {
    liabilities: {
      capitalAccount: StatementGroup;
      loans: StatementGroup;
      currentLiabilities: StatementGroup & { dutyAndTax: number };
      pandlCarryForward: number;
      difference: number;
      total: number;
    };
    assets: {
      fixedAssets: StatementGroup;
      currentAssets: StatementGroup;
      closingStock: number;
      total: number;
    };
  };
  openingBalances: OpeningBalanceSummary;
  capitalisationOverlay: { finishedGoods: number; absorbed: number; net: number };
  integrity: BooksIntegrity;
}

/**
 * Build the P&L and Balance Sheet for a period from the derived postings.
 *
 * `buildDerivedPostings` is injected rather than imported so this module does
 * not depend on the route file that owns it.
 */
export async function buildBooks(
  buildDerivedPostings: (opts: { toDate?: string }) => Promise<Array<{ date: string; ledgerId: number; debit: number; credit: number }>>,
  opts: BooksOptions = {},
): Promise<Books> {
  const fromDate = isDate(opts.fromDate) ? opts.fromDate : null;
  const toDate = isDate(opts.toDate) ? opts.toDate : null;

  const chart = await loadChart();
  const postings = await buildDerivedPostings(toDate ? { toDate } : {});

  const overlayIds = new Set<number>();
  for (const code of CAPITALISATION_LEDGERS) {
    const node = chart.byCode.get(code);
    if (node) overlayIds.add(node.id);
  }

  // Two aggregations: the period drives the P&L, everything-to-date drives the
  // balance sheet (a balance sheet is cumulative by definition).
  const periodAgg = new Map<number, LedgerAgg>();
  const cumulativeAgg = new Map<number, LedgerAgg>();
  const overlay = { finishedGoods: 0, absorbed: 0 };
  const missingLedgerIds = new Set<number>();

  const bump = (map: Map<number, LedgerAgg>, id: number, dr: number, cr: number) => {
    const a = map.get(id) ?? { dr: 0, cr: 0 };
    a.dr = r2(a.dr + dr);
    a.cr = r2(a.cr + cr);
    map.set(id, a);
  };

  for (const p of postings) {
    const id = Number(p.ledgerId);
    if (!chart.byId.has(id)) { missingLedgerIds.add(id); continue; }
    if (overlayIds.has(id)) {
      const code = chart.byId.get(id)!.code;
      if (code === "STD-FG-INV") overlay.finishedGoods = r2(overlay.finishedGoods + p.debit - p.credit);
      else overlay.absorbed = r2(overlay.absorbed + p.debit - p.credit);
      continue;
    }
    bump(cumulativeAgg, id, p.debit, p.credit);
    if (!fromDate || String(p.date).slice(0, 10) >= fromDate) bump(periodAgg, id, p.debit, p.credit);
  }

  // Opening balances are outside the posting stream, so they are added to the
  // cumulative (balance-sheet) view only, and must self-balance.
  const obParams: any[] = [];
  let obWhere = "";
  if (toDate) { obParams.push(toDate); obWhere = `WHERE as_of_date <= $1`; }
  const { rows: obRows } = await pool.query(
    `SELECT ledger_id, balance::numeric AS balance, balance_type FROM opening_balances ${obWhere}`,
    obParams,
  );
  const openingBalances: OpeningBalanceSummary = { debit: 0, credit: 0, balanced: true, lines: obRows.length };
  for (const ob of obRows) {
    const id = Number(ob.ledger_id);
    const amt = Number(ob.balance);
    const isDebit = String(ob.balance_type ?? "debit").toLowerCase() === "debit";
    if (isDebit) openingBalances.debit = r2(openingBalances.debit + amt);
    else openingBalances.credit = r2(openingBalances.credit + amt);
    if (!chart.byId.has(id)) { missingLedgerIds.add(id); continue; }
    bump(cumulativeAgg, id, isDebit ? amt : 0, isDebit ? 0 : amt);
  }
  openingBalances.balanced = Math.abs(openingBalances.debit - openingBalances.credit) < 0.01;

  // Stock. Opening stock is the position at the close of the day before the
  // period starts; with no start date the period runs from inception, so there
  // is nothing to bring in.
  //
  // Closing stock must be dated to `toDate`, not to today. `stock_entries` holds
  // only the current position, so asking for a past period with today's stock
  // silently reports today's inventory as that period's closing stock — which
  // corrupts COGS, net profit and the balance sheet's "as at" inventory alike.
  // Only when the statement genuinely runs to today (or has no end date) is the
  // current position the right answer, and only then is it exact.
  const historicalClose = toDate !== null && toDate < todayISO();
  const closing = historicalClose ? await stockAsOf(toDate) : await closingStockAt();
  const opening = fromDate ? await stockAsOf(previousDay(fromDate)) : await stockAsOf(null);

  // ── Group builders ────────────────────────────────────────────────────────

  /** Build a presentation subtree, signed so the section's natural side is positive. */
  const buildGroup = (code: string, agg: Map<number, LedgerAgg>, sign: 1 | -1): StatementGroup => {
    const root = chart.byCode.get(code);
    if (!root) return { id: null, name: code, code, total: 0, children: [] };

    const serialize = (node: ChartNode): { node: StatementNode; total: number } => {
      const own = overlayIds.has(node.id) || node.isSystemGroup ? 0 : sign * netOf(agg.get(node.id));
      const kids = node.children.map(serialize);
      const total = r2(kids.reduce((s, k) => s + k.total, own));
      return {
        node: {
          id: node.id, name: node.name, code: node.code, type: node.type,
          isGroup: node.isGroup, isSystemGroup: node.isSystemGroup,
          balance: r2(own + kids.reduce((s, k) => s + k.total, 0)),
          children: kids.map((k) => k.node),
        },
        total,
      };
    };

    const kids = root.children.map(serialize);
    // A system group holds no postings of its own; its total is its children's.
    const ownRoot = root.isSystemGroup ? 0 : sign * netOf(agg.get(root.id));
    return {
      id: root.id, name: root.name, code: root.code ?? code, type: root.type,
      total: r2(kids.reduce((s, k) => s + k.total, ownRoot)),
      children: kids.map((k) => k.node),
    };
  };

  // ── Profit & loss (period) ────────────────────────────────────────────────
  const salesGroup = buildGroup("SYS-SAL", periodAgg, -1);
  const directInc = buildGroup("SYS-DIRINC", periodAgg, -1);
  const indirectInc = buildGroup("SYS-INDINC", periodAgg, -1);
  const purchasesGroup = buildGroup("SYS-PUR", periodAgg, 1);
  const directExp = buildGroup("SYS-DIREXP", periodAgg, 1);
  const indirectExp = buildGroup("SYS-INDEXP", periodAgg, 1);

  const totalExpenses = r2(opening.total + purchasesGroup.total + directExp.total + indirectExp.total);
  const totalIncomes = r2(salesGroup.total + closing.total + directInc.total + indirectInc.total);
  const netProfit = r2(totalIncomes - totalExpenses);

  const revenue = r2(salesGroup.total + directInc.total);
  const cogs = r2(opening.total + purchasesGroup.total + directExp.total - closing.total);
  const grossProfit = r2(revenue - cogs);
  const pct = (part: number, whole: number) => (Math.abs(whole) < 0.005 ? 0 : r2((part / whole) * 100));

  // ── Balance sheet (cumulative to `toDate`) ───────────────────────────────
  const capitalGroup = buildGroup("SYS-CAP", cumulativeAgg, -1);
  const loansGroup = buildGroup("SYS-LOAN", cumulativeAgg, -1);
  const curlGroup = buildGroup("SYS-CURL", cumulativeAgg, -1);
  const fixedGroup = buildGroup("SYS-FIXD", cumulativeAgg, 1);
  const curaGroup = buildGroup("SYS-CURA", cumulativeAgg, 1);
  const dtxNode = chart.byCode.get("STD-DTX");
  const dutyAndTax = dtxNode
    ? r2(-1 * [...chart.subtree(dtxNode.id)].reduce((s, id) => s + netOf(cumulativeAgg.get(id)), 0))
    : 0;

  // Retained earnings must be cumulative to match the cumulative ledger
  // balances, so it is recomputed over everything to date rather than reusing
  // the period profit. Closing stock is the only inventory carried in — the
  // capitalisation overlay is excluded from both sides.
  let cumulativeIncome = 0;
  let cumulativeExpense = 0;
  const unclassified: string[] = [];
  const plIncomeIds = chart.idsUnder(PL_INCOME_ROOTS);
  const plExpenseIds = chart.idsUnder(PL_EXPENSE_ROOTS);
  const bsIds = new Set<number>([...chart.idsUnder(BS_LIABILITY_ROOTS), ...chart.idsUnder(BS_ASSET_ROOTS)]);

  for (const [id, a] of cumulativeAgg) {
    const net = netOf(a);
    if (Math.abs(net) < 0.005) continue;
    if (plIncomeIds.has(id)) { cumulativeIncome = r2(cumulativeIncome - net); continue; }
    if (plExpenseIds.has(id)) { cumulativeExpense = r2(cumulativeExpense + net); continue; }
    if (bsIds.has(id)) continue;
    const node = chart.byId.get(id);
    unclassified.push(`${node?.name ?? `Ledger #${id}`}${node?.code ? ` (${node.code})` : ""} — ₹${Math.abs(net).toFixed(2)}`);
  }
  const retainedEarnings = r2(cumulativeIncome + closing.total - cumulativeExpense);

  const assetsTotal = r2(fixedGroup.total + curaGroup.total + closing.total);
  const liabilitiesTotal = r2(capitalGroup.total + loansGroup.total + curlGroup.total + retainedEarnings);
  const difference = r2(assetsTotal - liabilitiesTotal);

  // ── Integrity ─────────────────────────────────────────────────────────────
  const issues: string[] = [];
  if (missingLedgerIds.size > 0) {
    issues.push(
      `${missingLedgerIds.size} posting${missingLedgerIds.size === 1 ? " refers" : "s refer"} to a ledger that no longer exists (id ${[...missingLedgerIds].slice(0, 5).join(", ")}${missingLedgerIds.size > 5 ? ", …" : ""}). Restore the ledger or reverse the entries.`,
    );
  }
  if (unclassified.length > 0) {
    issues.push(
      `${unclassified.length} ledger${unclassified.length === 1 ? " has" : "s have"} a balance but sit under no reporting group, so ${unclassified.length === 1 ? "it is" : "they are"} in neither statement: ${unclassified.slice(0, 5).join("; ")}${unclassified.length > 5 ? "; …" : ""}. Move ${unclassified.length === 1 ? "it" : "them"} under a group in the Chart of Accounts.`,
    );
  }
  if (!openingBalances.balanced) {
    issues.push(
      `Opening balances do not balance: debits ₹${openingBalances.debit.toFixed(2)} against credits ₹${openingBalances.credit.toFixed(2)}.`,
    );
  }
  const overlayNet = r2(overlay.finishedGoods + overlay.absorbed);
  if (Math.abs(overlayNet) > 0.01) {
    issues.push(
      `Production cost capitalised into stock does not net to zero (₹${overlayNet.toFixed(2)}). Finished Goods Inventory and Production Cost Absorbed must always move together.`,
    );
  }
  // Inventory that is not derivable does not unbalance the statements — closing
  // stock enters the P&L and the balance sheet as the same number — but it does
  // make cost of goods sold, net profit and total assets wrong, so it is an
  // integrity failure rather than a footnote.
  if (historicalClose && !closing.reliable) {
    issues.push(
      `Closing stock as at ${toDate} cannot be established: stock movement history does not reach back that far, so cost of goods sold, net profit and total assets are all unreliable for this period. Run the statement to today for figures that can be trusted.`,
    );
  }
  if (fromDate && !opening.reliable) {
    issues.push(
      `Opening stock as at ${previousDay(fromDate)} cannot be established from stock movement history, so cost of goods sold and net profit are understated or overstated by the true opening position.`,
    );
  }
  if (Math.abs(difference) > 0.01 && issues.length === 0) {
    issues.push(
      `Assets and liabilities differ by ₹${Math.abs(difference).toFixed(2)} with no identifiable cause. The books need review before this statement is relied on.`,
    );
  }

  return {
    period: { fromDate, toDate },
    profitAndLoss: {
      expenses: {
        openingStock: opening.total,
        openingStockItems: opening.items,
        openingStockReliable: opening.reliable,
        openingStockNote: opening.note,
        purchases: purchasesGroup.total,
        purchasesGroup,
        directExpenses: directExp,
        indirectExpenses: indirectExp,
        total: totalExpenses,
      },
      incomes: {
        sales: salesGroup.total,
        salesGroup,
        closingStock: closing.total,
        closingStockItems: closing.items,
        closingStockInTransit: closing.inTransit,
        closingStockReliable: closing.reliable && !historicalClose,
        closingStockNote: historicalClose
          ? [closing.note, HISTORICAL_CLOSE_NOTE].filter(Boolean).join(" ")
          : closing.note,
        directIncomes: directInc,
        indirectIncomes: indirectInc,
        total: totalIncomes,
      },
      summary: {
        revenue,
        costOfGoodsSold: cogs,
        grossProfit,
        grossMarginPct: pct(grossProfit, revenue),
        otherIncome: indirectInc.total,
        operatingExpenses: indirectExp.total,
        netProfit,
        netMarginPct: pct(netProfit, revenue),
      },
      netProfit,
    },
    balanceSheet: {
      liabilities: {
        capitalAccount: capitalGroup,
        loans: loansGroup,
        currentLiabilities: { ...curlGroup, dutyAndTax },
        pandlCarryForward: retainedEarnings,
        difference: Math.abs(difference) > 0.01 ? difference : 0,
        total: liabilitiesTotal,
      },
      assets: {
        fixedAssets: fixedGroup,
        currentAssets: curaGroup,
        closingStock: closing.total,
        total: assetsTotal,
      },
    },
    openingBalances,
    capitalisationOverlay: {
      finishedGoods: overlay.finishedGoods,
      absorbed: overlay.absorbed,
      net: overlayNet,
    },
    integrity: {
      balanced: Math.abs(difference) < 0.01 && issues.length === 0,
      difference: Math.abs(difference) > 0.01 ? difference : 0,
      issues,
    },
  };
}
