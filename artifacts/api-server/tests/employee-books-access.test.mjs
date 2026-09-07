/**
 * Employee Cash Book / Bank Book authorization regression suite.
 *
 * Proves that page permission and location/data scope both apply to the shared
 * ledger-list and book-data endpoints. The suite creates only a role, employee,
 * and permission rows; it does not create accounting transactions.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const TAG = "ZZBOOK";

let adminToken = "";
let employeeToken = "";
let hierarchyId = 0;
let createdBankRecon = null;
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(label);
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

async function api(method, path, body, token = adminToken) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function login(username, password) {
  const result = await api("POST", "/auth/login", { username, password }, "");
  return result.data?.token ?? "";
}

async function cleanup() {
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
  await sql(
    `DELETE FROM permissions
     WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`,
    [`${TAG}%`],
  );
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
}

function permissionBody(canView, canEdit = false) {
  return {
    hierarchyId,
    canView,
    canAdd: false,
    canEdit,
    canDelete: false,
    canDownload: false,
  };
}

async function setBookPermissions({ cash, bank, bankEdit = false }) {
  const cashResult = await api(
    "POST",
    "/company/permissions",
    { module: "page:/accounts/cash-book", ...permissionBody(cash) },
  );
  const bankResult = await api(
    "POST",
    "/company/permissions",
    { module: "page:/accounts/bank-book", ...permissionBody(bank, bankEdit) },
  );
  assert("Cash Book permission update accepted", cashResult.status === 200 || cashResult.status === 201);
  assert("Bank Book permission update accepted", bankResult.status === 200 || bankResult.status === 201);
}

try {
  console.log("\n[0] Fixture setup");
  await cleanup();
  const root = (
    await sql(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`)
  ).rows[0];
  if (!root) throw new Error("no Administrator hierarchy");
  const adminPassword = "zzbook-admin-password";
  await sql(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, must_change_password, is_active)
     VALUES ($1, $2, $3, $4, 'headoffice', 0, 10000, CURRENT_DATE, false, true)`,
    [
      `${TAG} Admin`,
      `${TAG.toLowerCase()}_admin`,
      bcrypt.hashSync(adminPassword, 10),
      Number(root.id),
    ],
  );
  adminToken = await login(
    `${TAG.toLowerCase()}_admin`,
    adminPassword,
  );
  assert("Admin login returns a token", !!adminToken);
  if (!adminToken) throw new Error("admin login failed");

  const fixtureRows = (
    await sql(`
      SELECT w.id AS warehouse_id, w.cash_ledger_id,
             cba.ledger_id AS bank_ledger_id
      FROM warehouses w
      JOIN cash_bank_accounts cba
        ON cba.location_type = 'warehouse' AND cba.location_id = w.id
       AND cba.ledger_id IS NOT NULL
       AND cba.account_type <> 'cash'
      WHERE w.cash_ledger_id IS NOT NULL
        AND w.disabled_at IS NULL
      ORDER BY w.id, cba.id
      LIMIT 1
    `)
  ).rows;
  const fixture = fixtureRows[0];
  assert("A live warehouse has both cash and bank ledgers", !!fixture);
  if (!fixture) throw new Error("no warehouse with both cash and bank ledgers");

  const roots = {
    cash: (await api("GET", "/accounts/cash-bank-book/ledgers?kind=cash")).data ?? [],
    bank: (await api("GET", "/accounts/cash-bank-book/ledgers?kind=bank")).data ?? [],
  };
  const cashRoot = roots.cash.find((row) => row.code === "STD-CASH");
  const bankRoot = roots.bank.find((row) => row.code === "STD-BANK");
  assert("Admin Cash Book ledger list is populated", roots.cash.length > 0);
  assert("Admin Bank Book ledger list is populated", roots.bank.length > 0);
  assert("Admin Cash Book still exposes the Cash root", Number(cashRoot?.id) > 0);
  assert("Admin Bank Book still exposes the Bank root", Number(bankRoot?.id) > 0);

  const role = await api("POST", "/hr/hierarchies", {
    name: `${TAG} Clerk`,
    reportsToId: root.id,
    description: "disposable Cash/Bank Book authorization fixture",
  });
  hierarchyId = Number(role.data?.id ?? 0);
  assert("Fixture role created", role.status === 201 && hierarchyId > 0);

  const password = "marlin1458";
  await sql(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, must_change_password, is_active)
     VALUES ($1, $2, $3, $4, 'warehouse', $5, 10000, CURRENT_DATE, false, true)`,
    [
      `${TAG} Clerk`,
      `${TAG.toLowerCase()}_clerk`,
      bcrypt.hashSync(password, 10),
      hierarchyId,
      Number(fixture.warehouse_id),
    ],
  );

  console.log("\n[A] Employee without either book permission");
  await setBookPermissions({ cash: false, bank: false });
  employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
  assert("Fixture employee can log in", !!employeeToken);
  let response = await api(
    "GET",
    "/accounts/cash-bank-book/ledgers?kind=cash",
    undefined,
    employeeToken,
  );
  assert("Cash ledger list denied without Cash Book permission", response.status === 403);
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.cash_ledger_id}&kind=cash`,
    undefined,
    employeeToken,
  );
  assert("Cash book data denied without Cash Book permission", response.status === 403);

  console.log("\n[B] Employee with Cash Book permission only");
  await setBookPermissions({ cash: true, bank: false });
  employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
  response = await api(
    "GET",
    "/accounts/cash-bank-book/ledgers?kind=cash",
    undefined,
    employeeToken,
  );
  assert("Cash ledger list allowed with Cash Book permission", response.status === 200);
  assert(
    "Cash ledger selector contains the employee's warehouse cash ledger",
    response.data.some((row) => Number(row.id) === Number(fixture.cash_ledger_id)),
  );
  assert(
    "Cash ledger selector does not expose the Cash root",
    !response.data.some((row) => row.code === "STD-CASH"),
  );
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.cash_ledger_id}&kind=cash&fromDate=2000-01-01&toDate=2099-12-31`,
    undefined,
    employeeToken,
  );
  assert("Cash book data allowed for the authorized ledger", response.status === 200);
  assert("Cash book returns the selected ledger", Number(response.data.ledger?.id) === Number(fixture.cash_ledger_id));
  assert("Cash book returns opening balance and running-balance entries", (
    typeof response.data.openingBalance === "number" &&
    Array.isArray(response.data.entries) &&
    typeof response.data.closingBalance === "number"
  ));
  response = await api(
    "GET",
    "/accounts/cash-bank-book/ledgers?kind=bank",
    undefined,
    employeeToken,
  );
  assert("Bank ledger list denied with only Cash Book permission", response.status === 403);
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.bank_ledger_id}&kind=bank`,
    undefined,
    employeeToken,
  );
  assert("Bank book data denied with only Cash Book permission", response.status === 403);
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.bank_ledger_id}`,
    undefined,
    employeeToken,
  );
  assert("Bank book data cannot bypass permission by omitting kind", response.status === 403);

  console.log("\n[C] Employee with Bank Book permission only");
  await setBookPermissions({ cash: false, bank: true });
  employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
  response = await api(
    "GET",
    "/accounts/cash-bank-book/ledgers?kind=bank",
    undefined,
    employeeToken,
  );
  assert("Bank ledger list allowed with Bank Book permission", response.status === 200);
  assert(
    "Bank ledger selector contains the employee's warehouse bank ledger",
    response.data.some((row) => Number(row.id) === Number(fixture.bank_ledger_id)),
  );
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.bank_ledger_id}&kind=bank&fromDate=2000-01-01&toDate=2099-12-31`,
    undefined,
    employeeToken,
  );
  assert("Bank book data allowed for the authorized ledger", response.status === 200);
  assert("Bank book returns the selected ledger", Number(response.data.ledger?.id) === Number(fixture.bank_ledger_id));
  assert("Bank book returns opening balance and running-balance entries", (
    typeof response.data.openingBalance === "number" &&
    Array.isArray(response.data.entries) &&
    typeof response.data.closingBalance === "number"
  ));

  const bankEntry = response.data.entries?.find(
    (row) => row.reconciliationEligible && row.reconciliationStatus === "unreconciled",
  );
  if (bankEntry) {
    const existingRecon = (
      await sql(
        `SELECT id FROM bank_reconciliation_entries
         WHERE ledger_id = $1 AND entry_id = $2`,
        [Number(bankEntry.ledgerId), bankEntry.entryId],
      )
    ).rows[0];
    if (!existingRecon) {
      createdBankRecon = {
        ledgerId: Number(bankEntry.ledgerId),
        entryId: bankEntry.entryId,
      };
    }

    const beforePostingCount = Number(
      (await sql(`SELECT COUNT(*)::int AS count FROM journal_vouchers`)).rows[0].count,
    );
    await setBookPermissions({ cash: false, bank: true, bankEdit: true });
    employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
    response = await api(
      "POST",
      `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`,
      { ledgerId: Number(bankEntry.ledgerId), reconciled: true },
      employeeToken,
    );
    assert("Bank Book checkbox persists reconciliation", response.status === 200 && response.data.reconciliationStatus === "reconciled");

    response = await api(
      "GET",
      `/accounts/cash-bank-book?ledgerId=${fixture.bank_ledger_id}&kind=bank&fromDate=2000-01-01&toDate=2099-12-31`,
      undefined,
      employeeToken,
    );
    const refreshedEntry = response.data.entries?.find((row) => row.entryId === bankEntry.entryId);
    assert("Reconciliation survives a Bank Book refresh", refreshedEntry?.reconciliationStatus === "reconciled");

    const concurrent = await Promise.all([
      api("POST", `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`, {
        ledgerId: Number(bankEntry.ledgerId), reconciled: true,
      }, employeeToken),
      api("POST", `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`, {
        ledgerId: Number(bankEntry.ledgerId), reconciled: true,
      }, employeeToken),
    ]);
    assert("Concurrent reconciliation requests are idempotent", concurrent.every((r) => r.status === 200));
    const rowCount = Number(
      (await sql(
        `SELECT COUNT(*)::int AS count FROM bank_reconciliation_entries
         WHERE ledger_id = $1 AND entry_id = $2`,
        [Number(bankEntry.ledgerId), bankEntry.entryId],
      )).rows[0].count,
    );
    assert("Concurrent requests leave one reconciliation record", rowCount === 1);

    response = await api(
      "GET",
      "/reconciliation/reconciled?status=reconciled",
      undefined,
      adminToken,
    );
    assert("Reconciliation review includes the Bank Book transaction", response.data.some(
      (row) => row.entryType === "bank_book" && row.entryId === bankEntry.entryId,
    ));

    response = await api(
      "POST",
      `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`,
      { ledgerId: Number(bankEntry.ledgerId), reconciled: false },
      employeeToken,
    );
    assert("Bank Book checkbox supports unreconcile", response.status === 200 && response.data.reconciliationStatus === "unreconciled");

    const afterPostingCount = Number(
      (await sql(`SELECT COUNT(*)::int AS count FROM journal_vouchers`)).rows[0].count,
    );
    assert("Status-only reconciliation does not create journal vouchers", beforePostingCount === afterPostingCount);

    await setBookPermissions({ cash: false, bank: false });
    employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
    response = await api(
      "POST",
      `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`,
      { ledgerId: Number(bankEntry.ledgerId), reconciled: true },
      employeeToken,
    );
    assert("Bank Book reconciliation respects action permission", response.status === 403);

    await setBookPermissions({ cash: false, bank: true, bankEdit: true });
    employeeToken = await login(`${TAG.toLowerCase()}_clerk`, password);
    response = await api(
      "POST",
      `/reconciliation/bank-book/${encodeURIComponent(bankEntry.entryId)}/reconcile`,
      { ledgerId: Number(bankRoot?.id), reconciled: true },
      employeeToken,
    );
    assert("Bank Book reconciliation rejects the wrong bank account", response.status === 403 || response.status === 404);
  } else {
    console.log("  - No unreconciled Bank Book entry available; mutation probes skipped");
  }
  response = await api(
    "GET",
    "/accounts/cash-bank-book/ledgers?kind=cash",
    undefined,
    employeeToken,
  );
  assert("Cash ledger list denied with only Bank Book permission", response.status === 403);

  console.log("\n[D] Location and ledger authorization");
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${cashRoot?.id}&kind=cash`,
    undefined,
    employeeToken,
  );
  assert("Employee cannot select the unrestricted Cash root", response.status === 403 || response.status === 404);
  response = await api(
    "GET",
    `/accounts/cash-bank-book?ledgerId=${fixture.cash_ledger_id}&kind=bank`,
    undefined,
    employeeToken,
  );
  assert("Employee cannot relabel a cash ledger as a bank ledger", response.status === 403 || response.status === 404);

  const foreign = (
    await sql(
      `SELECT id, cash_ledger_id FROM warehouses
       WHERE id <> $1 AND cash_ledger_id IS NOT NULL AND disabled_at IS NULL
       ORDER BY id LIMIT 1`,
      [Number(fixture.warehouse_id)],
    )
  ).rows[0];
  if (foreign) {
    response = await api(
      "GET",
      `/accounts/cash-bank-book?ledgerId=${foreign.cash_ledger_id}&kind=cash`,
      undefined,
      employeeToken,
    );
    assert("Employee cannot select a foreign warehouse ledger", response.status === 403 || response.status === 404);
  } else {
    console.log("  - No second live warehouse; foreign-ledger probe skipped");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error("Failures:");
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("\nSUITE ERROR:", error);
  process.exitCode = 1;
} finally {
  try {
    if (createdBankRecon) {
      await sql(
        `DELETE FROM bank_reconciliation_entries WHERE ledger_id = $1 AND entry_id = $2`,
        [createdBankRecon.ledgerId, createdBankRecon.entryId],
      );
    }
    await cleanup();
    console.log("\n  ✓ fixtures removed");
  } catch (error) {
    console.error("\n  ✗ fixture cleanup failed:", error?.message ?? error);
    process.exitCode = 1;
  }
  await pool.end();
}