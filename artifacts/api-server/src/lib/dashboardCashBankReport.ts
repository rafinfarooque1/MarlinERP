import { pool } from "@workspace/db";
import { outletWritesBlocked } from "./featureFlags";
import { openingBalancePostings } from "./openingBalances";

type CashBankPosting = {
  date: string | Date;
  ledgerId: number;
  debit: number | string;
  credit: number | string;
  source?: string;
  locationType?: string | null;
  locationId?: number | null;
};

type CashBankReportRow = {
  ledgerId: number;
  name: string;
  opening: number;
  receipt: number;
  payment: number;
  closing: number;
};

type CashBankReportSection = {
  rows: CashBankReportRow[];
  totals: Omit<CashBankReportRow, "ledgerId" | "name">;
};

export type DashboardCashBankLedgerAccount = {
  ledgerId: number;
  name: string;
  kind: "cash" | "bank";
};

export type DashboardCashBankReport = {
  period: { fromDate: string | null; toDate: string | null };
  bank: CashBankReportSection;
  cash: CashBankReportSection;
};

function cents(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function rupees(value: number): number {
  return Math.round(value) / 100;
}

function postingDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function locationKey(type: unknown, id: unknown): string | null {
  if (type === "headoffice") return "headoffice:0";
  if (type !== "warehouse" && type !== "outlet") return null;
  const locationId = Number(id);
  return Number.isInteger(locationId) && locationId > 0 ? `${type}:${locationId}` : null;
}

/** Fold one already-scoped posting stream into account-level period figures. */
export function aggregateDashboardCashBankReport(
  accounts: DashboardCashBankLedgerAccount[],
  postings: CashBankPosting[],
  fromDate: string | null,
  toDate: string | null,
): Pick<DashboardCashBankReport, "bank" | "cash"> {
  const amountsByLedger = new Map<number, { opening: number; receipt: number; payment: number }>();
  for (const posting of postings) {
    const ledgerId = Number(posting.ledgerId);
    if (!Number.isInteger(ledgerId) || ledgerId <= 0) continue;
    const amount = amountsByLedger.get(ledgerId) ?? { opening: 0, receipt: 0, payment: 0 };
    const date = postingDate(posting.date);
    if (fromDate && date < fromDate) {
      amount.opening += cents(posting.debit) - cents(posting.credit);
    } else if (!toDate || date <= toDate) {
      amount.receipt += cents(posting.debit);
      amount.payment += cents(posting.credit);
    }
    amountsByLedger.set(ledgerId, amount);
  }

  const totalsFor = (kind: "cash" | "bank"): CashBankReportSection => {
    const rows = accounts
      .filter((account) => account.kind === kind)
      .map((account) => {
        const amounts = amountsByLedger.get(account.ledgerId) ?? { opening: 0, receipt: 0, payment: 0 };
        const closing = amounts.opening + amounts.receipt - amounts.payment;
        return {
          ledgerId: account.ledgerId,
          name: account.name,
          opening: amounts.opening,
          receipt: amounts.receipt,
          payment: amounts.payment,
          closing,
        };
      })
      .filter((row) => row.opening !== 0 || row.receipt !== 0 || row.payment !== 0 || row.closing !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const totals = rows.reduce((sum, row) => ({
      opening: sum.opening + row.opening,
      receipt: sum.receipt + row.receipt,
      payment: sum.payment + row.payment,
      closing: sum.closing + row.closing,
    }), { opening: 0, receipt: 0, payment: 0, closing: 0 });

    return {
      rows: rows.map((row) => ({
        ledgerId: row.ledgerId,
        name: row.name,
        opening: rupees(row.opening),
        receipt: rupees(row.receipt),
        payment: rupees(row.payment),
        closing: rupees(row.closing),
      })),
      totals: {
        opening: rupees(totals.opening),
        receipt: rupees(totals.receipt),
        payment: rupees(totals.payment),
        closing: rupees(totals.closing),
      },
    };
  };

  return { bank: totalsFor("bank"), cash: totalsFor("cash") };
}

/**
 * Account-level cash and bank balances for the dashboard's cross-location
 * report. Availability follows managed-account memberships, while amounts
 * always come from the derived posting stream plus the one opening-balance
 * posting fold used by the books.
 */
export async function buildDashboardCashBankReport(opts: {
  postings: CashBankPosting[];
  fromDate: string | null;
  toDate: string | null;
  activeLocations: Array<{ locationType: string; locationId: number }>;
  includeCompanyLevel: boolean;
  cashLedgerIds: number[];
  bankLedgerIds: number[];
}): Promise<DashboardCashBankReport> {
  const cashLedgerIds = new Set(opts.cashLedgerIds.map(Number));
  const bankLedgerIds = new Set(opts.bankLedgerIds.map(Number));
  const allLedgerIds = Array.from(new Set([...cashLedgerIds, ...bankLedgerIds]));
  const activeLocationKeys = new Set(
    opts.activeLocations
      .map((location) => locationKey(location.locationType, location.locationId))
      .filter((key): key is string => key != null),
  );

  const [ledgerResult, accountResult, warehouseResult, outletsBlocked] = await Promise.all([
    pool.query(`SELECT id, name FROM account_ledgers WHERE id = ANY($1::int[])`, [allLedgerIds]),
    pool.query(`
      SELECT c.id, c.name, c.ledger_id, c.location_type, c.location_id,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'location_type', l.location_type,
                 'location_id', l.location_id
               ))
               FROM cash_bank_account_locations l
               WHERE l.account_id = c.id
             ), '[]'::json) AS memberships
        FROM cash_bank_accounts c
       WHERE c.ledger_id IS NOT NULL
       ORDER BY c.id
    `),
    pool.query(`
      SELECT id, name, cash_ledger_id
        FROM warehouses
       WHERE disabled_at IS NULL AND cash_ledger_id IS NOT NULL
    `),
    outletWritesBlocked(pool),
  ]);

  const outletResult = outletsBlocked
    ? { rows: [] as Array<Record<string, unknown>> }
    : await pool.query(`
        SELECT o.id, o.name, o.cash_ledger_id
          FROM outlets o
          JOIN warehouses w ON w.id = o.warehouse_id
         WHERE w.disabled_at IS NULL AND o.cash_ledger_id IS NOT NULL
      `);

  type LedgerMeta = {
    id: number;
    name: string;
    rootCode: "STD-CASH" | "STD-BANK";
  };

  const cashBankLedgers = new Map<number, LedgerMeta>();
  for (const row of ledgerResult.rows as Array<any>) {
    const id = Number(row.id);
    const rootCode = cashLedgerIds.has(id) ? "STD-CASH" : bankLedgerIds.has(id) ? "STD-BANK" : null;
    if (!rootCode) continue;
    cashBankLedgers.set(id, { id, name: String(row.name), rootCode });
  }

  const rowsByLedger = new Map<number, DashboardCashBankLedgerAccount>();
  const claimedLedgerIds = new Set<number>();
  const addLedger = (ledgerId: number, name?: string) => {
    const meta = cashBankLedgers.get(ledgerId);
    if (!meta || rowsByLedger.has(ledgerId)) return;
    rowsByLedger.set(ledgerId, {
      ledgerId,
      name: name || meta.name || `Ledger #${ledgerId}`,
      kind: meta.rootCode === "STD-CASH" ? "cash" : "bank",
    });
  };

  // Managed money accounts are available where their junction memberships
  // say they are; legacy rows without memberships use the scalar location.
  for (const account of accountResult.rows as Array<any>) {
    const ledgerId = Number(account.ledger_id);
    if (!Number.isInteger(ledgerId) || ledgerId <= 0) continue;
    claimedLedgerIds.add(ledgerId);
    const rawMemberships = Array.isArray(account.memberships) ? account.memberships : [];
    const memberships = rawMemberships.length > 0
      ? rawMemberships
      : [{
          location_type: account.location_type ?? "headoffice",
          location_id: account.location_type === "headoffice" || account.location_type == null
            ? 0
            : account.location_id,
        }];
    const hasVisibleMembership = memberships.some((membership: any) => {
      const key = locationKey(membership.location_type, membership.location_id);
      return key != null && activeLocationKeys.has(key);
    });
    if (!hasVisibleMembership) continue;
    addLedger(ledgerId, String(account.name));
  }

  // Location-owned cash tills are read-only mirrors. Prefer the warehouse
  // identity when a mirror warehouse/outlet shares one ledger.
  const tills = [
    ...(warehouseResult.rows as Array<any>).map((row) => ({
      locationType: "warehouse",
      locationId: Number(row.id),
      name: String(row.name),
      ledgerId: Number(row.cash_ledger_id),
    })),
    ...(outletResult.rows as Array<any>).map((row) => ({
      locationType: "outlet",
      locationId: Number(row.id),
      name: String(row.name),
      ledgerId: Number(row.cash_ledger_id),
    })),
  ];
  for (const till of tills) {
    const key = locationKey(till.locationType, till.locationId);
    if (!key || !activeLocationKeys.has(key) || claimedLedgerIds.has(till.ledgerId)) continue;
    claimedLedgerIds.add(till.ledgerId);
    addLedger(till.ledgerId, cashBankLedgers.get(till.ledgerId)?.name ?? `${till.name} Cash`);
  }

  // Head Office can see unmanaged cash/bank ledgers, including direct postings
  // on the root heads. Branch scopes get only their mapped accounts and tills.
  if (opts.includeCompanyLevel && activeLocationKeys.has("headoffice:0")) {
    for (const [ledgerId, meta] of cashBankLedgers) {
      if (claimedLedgerIds.has(ledgerId)) continue;
      claimedLedgerIds.add(ledgerId);
      addLedger(ledgerId, meta.name);
    }
  }

  const openings = await openingBalancePostings({ toDate: opts.toDate ?? undefined });
  const postings = [...opts.postings, ...openings] as CashBankPosting[];
  const visiblePostings = postings.filter((posting) => {
    if (posting.locationType == null) return opts.includeCompanyLevel;
    const key = locationKey(posting.locationType, posting.locationId);
    return key != null && activeLocationKeys.has(key);
  });

  const report = aggregateDashboardCashBankReport(
    Array.from(rowsByLedger.values()),
    visiblePostings,
    opts.fromDate,
    opts.toDate,
  );

  return {
    period: { fromDate: opts.fromDate, toDate: opts.toDate },
    ...report,
  };
}
