import { pool as _pool } from "@workspace/db";
import { logActivity } from "./audit";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Chart of Accounts structure: system sub-groups.
 *
 * Per-entity ledgers are provisioned one per employee, per location and per
 * rent agreement, so the chart grows without bound: a company with 40 staff
 * and 12 locations lands ~100 sibling ledgers directly under Current
 * Liabilities and Indirect Expense, which is unreadable.
 *
 * These containers give each family its own level:
 *
 *   Current Liabilities → Salary Payable → <Employee>
 *   Indirect Expense    → Rent Expense   → <Location>
 *
 * That was always the intent — `lib/rentLedgers.ts` documents exactly this
 * shape — the provisioning code simply parented one level too high.
 *
 * The containers are `is_group` + `is_system_group`, which is what the rest of
 * the system already keys on:
 *   · `buildBooks()` rolls a group's balance up from its children, so moving a
 *     ledger one level deeper cannot change any statement total.
 *   · `is_system_group` keeps them out of every posting picker and out of
 *     `getDescendantLedgerIds()`, so nothing can post to a container.
 *   · a `code` makes them unrenamable and undeletable through the API.
 */
export interface ContainerSpec {
  code: string;
  name: string;
  /** Code of the system group head this container sits under. */
  parentCode: string;
  type: "asset" | "liability" | "income" | "expense";
  section: "balance_sheet" | "profit_loss";
  description: string;
  /** System ledger codes that belong inside this container. */
  childCodes: RegExp[];
}

export const CHART_CONTAINERS: ContainerSpec[] = [
  {
    code: "STD-GRP-SAL-PAY",
    name: "Salary Payable",
    parentCode: "SYS-CURL",
    type: "liability",
    section: "balance_sheet",
    description: "Net salary owed to employees, one ledger per employee",
    childCodes: [/^SAL-PAY-\d+$/],
  },
  {
    code: "STD-GRP-RENT-PAY",
    name: "Rent Payable",
    parentCode: "SYS-CURL",
    type: "liability",
    section: "balance_sheet",
    description: "Accrued rent owed per location",
    childCodes: [/^RENT-PAY-\d+$/],
  },
  {
    // Reuses the pre-existing (unreferenced, unposted) "Salary Expense" ledger,
    // which sat at the root of the chart with no parent.
    code: "STD-SALARY-EXP",
    name: "Salary Expense",
    parentCode: "SYS-INDEXP",
    type: "expense",
    section: "profit_loss",
    description: "Salary cost, one ledger per employee",
    childCodes: [/^SAL-EMP-\d+$/],
  },
  {
    code: "STD-GRP-RENT-EXP",
    name: "Rent Expense",
    parentCode: "SYS-INDEXP",
    type: "expense",
    section: "profit_loss",
    description: "Rent cost, one ledger per location",
    childCodes: [/^RENT-EXP-\d+$/],
  },
  {
    code: "STD-GRP-LOC-SAL",
    name: "Location Sales",
    parentCode: "SYS-SAL",
    type: "income",
    section: "profit_loss",
    description: "Sales revenue, one ledger per location",
    childCodes: [/^WH-SAL-\d+$/, /^OUTLET-SAL-\d+$/],
  },
  {
    code: "STD-GRP-LOC-PUR",
    name: "Location Purchases",
    parentCode: "SYS-PUR",
    type: "expense",
    section: "profit_loss",
    description: "Purchases, one ledger per location",
    childCodes: [/^WH-PUR-\d+$/],
  },
  {
    code: "STD-GRP-EMP-ADV",
    name: "Employee Advances",
    parentCode: "SYS-CURA",
    type: "asset",
    section: "balance_sheet",
    description: "Salary advances recoverable, one ledger per employee",
    childCodes: [/^ADV-EMP-\d+$/],
  },
  // NOTE: there is deliberately NO "Customer Advances" group. A customer
  // advance is a CREDIT (negative) balance on the customer's single Sundry
  // Debtor ledger (business decision, Aug 2026) — the old STD-GRP-CUST-ADV /
  // CADV- structure was folded away by customer_advances_fold_v1.
  {
    code: "STD-GRP-VEND-ADV",
    name: "Vendor Advances",
    parentCode: "SYS-CURA",
    type: "asset",
    section: "balance_sheet",
    description: "Advances paid to vendors, one ledger per vendor",
    childCodes: [/^VADV-\d+$/],
  },
];

const byCode = new Map(CHART_CONTAINERS.map((c) => [c.code, c]));

/** The container a system ledger code belongs in, if any. */
export function containerCodeFor(ledgerCode: string): string | null {
  for (const spec of CHART_CONTAINERS) {
    if (spec.childCodes.some((re) => re.test(ledgerCode))) return spec.code;
  }
  return null;
}

/** Create one container if it is missing. Idempotent, safe under concurrency. */
async function ensureContainer(pool: Pool, spec: ContainerSpec): Promise<number | null> {
  const { rows: [parent] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [spec.parentCode],
  );
  if (!parent) return null; // chart not seeded yet — the caller retries next boot

  const { rows: [existing] } = await pool.query<{ id: number; parent_id: number | null }>(
    `SELECT id, parent_id FROM account_ledgers WHERE code = $1 LIMIT 1`, [spec.code],
  );
  if (existing) {
    // Converge shape: an older row may pre-date the container role (wrong
    // parent, or not marked as a group).
    await pool.query(
      `UPDATE account_ledgers
          SET parent_id = $1, is_group = true, is_system_group = true,
              type = $2, section = $3
        WHERE id = $4`,
      [parent.id, spec.type, spec.section, existing.id],
    );
    return existing.id;
  }

  const { rows: [created] } = await pool.query<{ id: number }>(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, $4, $5, true, true, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [spec.name, spec.type, spec.code, spec.section, parent.id, spec.description],
  );
  if (created) return created.id;

  const { rows: [retry] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [spec.code],
  );
  return retry?.id ?? null;
}

/**
 * Parent id for a newly provisioned system ledger.
 *
 * Provisioning sites pass the container code; if the container does not exist
 * yet it is created here, so a ledger provisioned before the boot migration has
 * run still lands in the right place.
 */
export async function resolveChartParentId(pool: Pool, code: string): Promise<number | null> {
  const spec = byCode.get(code);
  if (spec) {
    const id = await ensureContainer(pool, spec);
    if (id) return id;
    // Container could not be created (chart not seeded) — fall back to the
    // group head so provisioning never fails outright.
    const { rows: [parent] } = await pool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [spec.parentCode],
    );
    return parent?.id ?? null;
  }
  const { rows: [row] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  return row?.id ?? null;
}

/**
 * Boot migration: add the `is_active` column, create the containers and move
 * existing per-entity ledgers into them.
 *
 * A ledger is only moved when it still sits directly under the group head the
 * container belongs to — a ledger someone has deliberately filed elsewhere is
 * left alone.
 */
export async function ensureChartStructure(pool: Pool): Promise<void> {
  // Deactivation: the alternative to deleting a ledger that carries history.
  // Raw DDL, like every other column on this table beyond Drizzle's five —
  // read and write it with raw SQL only.
  await pool.query(
    `ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
  );

  let created = 0;
  let moved = 0;

  for (const spec of CHART_CONTAINERS) {
    const containerId = await ensureContainer(pool, spec);
    if (!containerId) continue;
    created++;

    const { rows: [parent] } = await pool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [spec.parentCode],
    );
    if (!parent) continue;

    const { rows: candidates } = await pool.query<{ id: number; code: string }>(
      `SELECT id, code FROM account_ledgers
        WHERE parent_id = $1 AND code IS NOT NULL AND id <> $2`,
      [parent.id, containerId],
    );
    const targets = candidates
      .filter((r) => spec.childCodes.some((re) => re.test(r.code)))
      .map((r) => r.id);
    if (targets.length === 0) continue;

    const { rowCount } = await pool.query(
      `UPDATE account_ledgers SET parent_id = $1 WHERE id = ANY($2::int[])`,
      [containerId, targets],
    );
    moved += rowCount ?? 0;
  }

  if (moved > 0) {
    console.log(`[migration] chart_structure: ${created} sub-group(s) ensured, ${moved} ledger(s) regrouped`);
  }
}

// ── Ledger usage ────────────────────────────────────────────────────────────
//
// `account_ledgers` has exactly one real foreign key pointing at it
// (`expenses.ledger_account_id`); every other reference is a plain integer
// column. So "does this ledger carry history?" has to be asked table by table,
// and the delete guard is only as good as this list.

interface UsageSource { table: string; cols: string[]; label: string }

const TRANSACTION_SOURCES: UsageSource[] = [
  { table: "journal_voucher_lines", cols: ["ledger_id"], label: "journal entries" },
  { table: "journal_vouchers", cols: ["party_ledger_id"], label: "journal vouchers" },
  { table: "payments", cols: ["paid_from_ledger_id", "paid_to_ledger_id"], label: "payment vouchers" },
  { table: "receipts", cols: ["received_from_ledger_id", "received_in_ledger_id"], label: "receipt vouchers" },
  { table: "expenses", cols: ["ledger_account_id"], label: "expenses" },
  { table: "cash_deposits", cols: ["source_cash_ledger_id", "destination_bank_ledger_id"], label: "cash deposits" },
  { table: "opening_balances", cols: ["ledger_id"], label: "opening balances" },
];

const MASTER_SOURCES: UsageSource[] = [
  { table: "warehouses", cols: ["cash_ledger_id", "sales_ledger_id", "purchase_ledger_id"], label: "a warehouse" },
  { table: "outlets", cols: ["cash_ledger_id", "sales_ledger_id"], label: "an outlet" },
  { table: "warehouse_rent_agreements", cols: ["expense_ledger_id", "payable_ledger_id"], label: "a rent agreement" },
  { table: "reconciliation_batches", cols: ["destination_bank_ledger_id"], label: "a settlement batch" },
];

export interface LedgerUsage {
  /** Postings and vouchers that reference the ledger. */
  transactions: number;
  /** Human labels for where those transactions live. */
  transactionSources: string[];
  /** Master records wired to the ledger (warehouse, outlet, rent agreement…). */
  references: string[];
}

/** One query for the whole chart — never one query per node. */
export async function loadLedgerUsage(pool: Pool): Promise<Map<number, LedgerUsage>> {
  const wanted = [...TRANSACTION_SOURCES, ...MASTER_SOURCES];
  const { rows: present } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...wanted.map((s) => s.table), "purchases", "sales"]],
  );
  const has = new Set(present.map((r) => `${r.table_name}.${r.column_name}`));

  const parts: string[] = [];
  const push = (sources: UsageSource[], kind: "txn" | "ref") => {
    for (const s of sources) {
      for (const col of s.cols) {
        if (!has.has(`${s.table}.${col}`)) continue;
        parts.push(
          `SELECT ${col} AS ledger_id, '${kind}' AS kind, '${s.label}' AS src
             FROM ${s.table} WHERE ${col} IS NOT NULL`,
        );
      }
    }
  };
  push(TRANSACTION_SOURCES, "txn");
  push(MASTER_SOURCES, "ref");

  // Other Purchase Charges live INSIDE a jsonb array on purchases, not in a
  // plain integer column — the generic shape above cannot see them. Deleting a
  // ledger a bill's charges reference would leave the derived vendor credit
  // unbalanced against a debit that classifies nowhere, so it must count as
  // usage exactly like any voucher line.
  if (has.has("purchases.other_charges")) {
    parts.push(
      `SELECT (e->>'ledgerId')::int AS ledger_id, 'txn' AS kind, 'purchase bill other charges' AS src
         FROM purchases, jsonb_array_elements(COALESCE(other_charges, '[]'::jsonb)) e
        WHERE e->>'ledgerId' ~ '^[0-9]+$'`,
    );
  }
  // Same rule for Other Charges on POS sales: each row credits its expense
  // ledger in the derived postings, so that ledger is in active use.
  if (has.has("sales.other_charges")) {
    parts.push(
      `SELECT (e->>'ledgerId')::int AS ledger_id, 'txn' AS kind, 'sale other charges' AS src
         FROM sales, jsonb_array_elements(COALESCE(other_charges, '[]'::jsonb)) e
        WHERE e->>'ledgerId' ~ '^[0-9]+$'`,
    );
  }

  const usage = new Map<number, LedgerUsage>();
  if (parts.length === 0) return usage;

  const { rows } = await pool.query<{ ledger_id: number; kind: string; src: string; n: string }>(
    `SELECT ledger_id, kind, src, COUNT(*) AS n FROM (${parts.join(" UNION ALL ")}) u
      GROUP BY ledger_id, kind, src`,
  );
  for (const r of rows) {
    const id = Number(r.ledger_id);
    const n = Number(r.n);
    if (!Number.isFinite(id) || n === 0) continue;
    const entry = usage.get(id) ?? { transactions: 0, transactionSources: [], references: [] };
    if (r.kind === "txn") {
      entry.transactions += n;
      if (!entry.transactionSources.includes(r.src)) entry.transactionSources.push(r.src);
    } else if (!entry.references.includes(r.src)) {
      entry.references.push(r.src);
    }
    usage.set(id, entry);
  }
  return usage;
}

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * Why this ledger cannot be deleted, or null when it can be.
 *
 * Returned with the chart so the page can disable the action and say why,
 * instead of offering a delete button that fails on click.
 */
export function deleteBlockReason(
  node: { isSystemGroup: boolean; code: string | null; childCount: number },
  usage: LedgerUsage | undefined,
): string | null {
  if (node.isSystemGroup) {
    return "This is a system group — the statements are built from it. Rename and delete are disabled.";
  }
  if (node.code) {
    return "This ledger is maintained by the system (it mirrors a master record). Deactivate it instead.";
  }
  if (node.childCount > 0) {
    return `This account has ${node.childCount} sub-account${node.childCount === 1 ? "" : "s"}. Move or delete them first.`;
  }
  if (usage && usage.transactions > 0) {
    return `This ledger carries ${usage.transactions} entr${usage.transactions === 1 ? "y" : "ies"} (${list(usage.transactionSources)}). Deleting it would break the audit trail — deactivate it instead.`;
  }
  if (usage && usage.references.length > 0) {
    return `This ledger is wired to ${list(usage.references)}. Unlink it there first.`;
  }
  return null;
}

// ── User chart-account creation ──────────────────────────────────────────────

export interface InsertChartAccountOpts {
  name: string;
  type: string;
  parentId: number;
  section: string | null;
  description: string | null;
  isGroup: boolean;
  user: string;
}

export interface InsertedChartAccount {
  id: number;
  name: string;
  type: string;
  parent_id: number | null;
  section: string | null;
  description: string | null;
  is_group: boolean;
}

/**
 * The ONE insert path for user-created chart accounts — shared by the manual
 * POST /accounts/chart route and the Data Import commit, so both produce the
 * same shape: `code` stays NULL (user accounts are codeless by design, which
 * is what keeps them renamable and deletable), `is_system_group` false, and
 * the same audit line.
 *
 * The CALLER validates the parent (group vs leaf, active, duplicate name) —
 * both callers do, with caller-appropriate wording.
 */
export async function insertChartAccount(
  pool: Pool,
  opts: InsertChartAccountOpts,
): Promise<InsertedChartAccount> {
  const { rows: [created] } = await pool.query<InsertedChartAccount>(
    `INSERT INTO account_ledgers (name, type, parent_id, section, description, is_group, is_system_group, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, false, true)
     RETURNING id, name, type, parent_id, section, description, is_group`,
    [opts.name, opts.type, opts.parentId, opts.section, opts.description, opts.isGroup],
  );

  await logActivity({
    action: "CREATE", module: "accounts",
    entityType: opts.isGroup ? "account_group" : "account_ledger", entityId: created.id,
    description:
      `Added chart ${opts.isGroup ? "group" : "ledger"} "${opts.name}" ` +
      `[before: none · after: name="${opts.name}", type=${created.type}, parentId=${opts.parentId}, isGroup=${opts.isGroup}]`,
    user: opts.user,
  });

  return created;
}
