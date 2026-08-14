/**
 * Dashboard tile ↔ source report parity — regression tests (task: dashboard redesign)
 * Run: node artifacts/api-server/tests/dashboard-parity.test.mjs
 *
 * READ-ONLY against the books: creates only a disposable level-1 probe user
 * (never 'admin'), deletes it at exit. No documents are created or changed.
 *
 * Every dashboard KPI card now drills into a filtered report; these tests
 * prove the card's figure equals that report's total for the same filters:
 *
 *  1. SALES — /dashboard/bi sales.total == /reports/sales-register totals.total
 *     for several ranges, for an explicit location, and for the header-based
 *     location context (the drill-down premise: the global selector carries
 *     location, so the target report opens on the same slice).
 *  2. WAREHOUSE SALES (#37) — /dashboard/summary totalSalesAmount equals the
 *     DB sum over non-cancelled, non-branch-transfer sales INCLUDING rows
 *     located at warehouses, and equals the all-time sales register.
 *     Σ bi.sales.byLocation == bi.sales.total with warehouse rows present.
 *  3. PROFITABILITY — bi.profit.{gross,net,cogs} == the P&L's own summary
 *     from /accounts/financial-statements for the same range (the COGS/GP/NP
 *     tiles read the P&L build, never a re-sum of subtrees).
 *  4. CASH/BANK — bi.cash.balance / bi.bank.balance == the Cash Book / Bank
 *     Book per-account closing positions summed (same posting stream), and
 *     moneyFlows totals are internally consistent.
 *  5. RECEIVABLES — bi.receivables.total == /outstanding/receivables
 *     totals.netDue (the ageing widget and the tile share one control figure).
 *  6. PURCHASES — bi.purchases.total == /reports/purchase-register totals for
 *     the same ranges (the tile's drill target).
 *  7. EXPENSES — bi.expenses.total == the P&L's Direct + Indirect expense
 *     group totals (the tile drills to the P&L #pl-expenses memo line, which
 *     displays exactly that sum); the Salary/Rent/Other breakdown re-sums.
 *  8. PAYABLES — allPayables == Suppliers + Salary + Rent, and each component
 *     equals its Balance Sheet liability line (SYS-CREDITORS control,
 *     STD-GRP-SAL-PAY, STD-GRP-RENT-PAY) — the tile drills to the Balance
 *     Sheet #bs-liabilities table that shows those three lines.
 *  9. PAYMENTS/RECEIPTS — moneyFlows.totalOut/totalIn == the combined
 *     Cash & Bank book's totalPayments/totalReceipts for the same range (the
 *     tiles' drill target; the cash book alone excludes bank movements), and
 *     the combined book equals cash book + bank book.
 * 10. INVENTORY — bi.inventory.valuation == /stock/valuation grandTotal (the
 *     Stock Valuation report the tile drills into).
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "dash_parity_probe";
const PASS = "Probe#Dash1";
let authToken = "";
let passed = 0, failed = 0;

function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}

async function apiReq(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const get = (p, h) => apiReq("GET", p, undefined, h);
const post = (p, b) => apiReq("POST", p, b);

const round2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const near = (a, b, eps = 0.06) => Math.abs(round2(a) - round2(b)) <= eps;
const TODAY = new Date().toISOString().slice(0, 10);
const EPOCH = "1900-01-01";
const monthStart = TODAY.slice(0, 8) + "01";

async function setupUser() {
  await teardownUser();
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'Dash Parity Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [USER, hash]);
}
async function teardownUser() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
  await q(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
  await q(`DELETE FROM employees WHERE username = $1`, [USER]);
}

await setupUser();
try {
  console.log("\n[0] Authentication");
  const loginRes = await post("/auth/login", { username: USER, password: PASS });
  authToken = loginRes.data?.token ?? "";
  assert("Probe user logs in", !!authToken, `status=${loginRes.status}`);
  if (!authToken) process.exit(1);

  // ── [1] Sales tile == Sales Register, across ranges ───────────────────────
  console.log("\n[1] Sales tile == Sales Register (same range)");
  const ranges = [
    ["today", TODAY, TODAY],
    ["month-to-date", monthStart, TODAY],
    ["all-time", EPOCH, TODAY],
  ];
  for (const [label, from, to] of ranges) {
    const bi = (await get(`/dashboard/bi?fromDate=${from}&toDate=${to}`)).data;
    const reg = (await get(`/reports/sales-register?from=${from}&to=${to}`)).data;
    assert(`bi.sales.total == register total (${label})`,
      near(bi?.sales?.total, reg?.totals?.total),
      `bi=${bi?.sales?.total} reg=${reg?.totals?.total}`);
    assert(`bi.sales.count == register invoices (${label})`,
      Number(bi?.sales?.count ?? -1) === Number(reg?.totals?.invoices ?? -2),
      `bi=${bi?.sales?.count} reg=${reg?.totals?.invoices}`);
  }

  // A location slice (explicit params, as HO can select) must agree too.
  const [locRow] = await q(
    `SELECT COALESCE(location_type,'outlet') AS lt, COALESCE(location_id, outlet_id) AS lid, COUNT(*) AS n
       FROM sales WHERE branch_transfer_id IS NULL AND cancelled_at IS NULL
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`);
  if (locRow) {
    const lq = `locationType=${locRow.lt}&locationId=${locRow.lid}`;
    const biL = (await get(`/dashboard/bi?fromDate=${EPOCH}&toDate=${TODAY}&${lq}`)).data;
    const regL = (await get(`/reports/sales-register?from=${EPOCH}&to=${TODAY}&${lq}`)).data;
    assert(`bi.sales.total == register total (located ${locRow.lt}#${locRow.lid}, query params)`,
      near(biL?.sales?.total, regL?.totals?.total),
      `bi=${biL?.sales?.total} reg=${regL?.totals?.total}`);

    // The drill-down premise: the URL carries only view+range — location rides
    // on the global x-location headers. Both endpoints must honour them alike.
    const hdrs = { "x-location-type": String(locRow.lt), "x-location-id": String(locRow.lid) };
    const biH = (await get(`/dashboard/bi?fromDate=${EPOCH}&toDate=${TODAY}`, hdrs)).data;
    const regH = (await get(`/reports/sales-register?from=${EPOCH}&to=${TODAY}`, hdrs)).data;
    assert("bi == register under x-location headers (drill-down carry-over)",
      near(biH?.sales?.total, regH?.totals?.total) && near(biH?.sales?.total, biL?.sales?.total),
      `biH=${biH?.sales?.total} regH=${regH?.totals?.total} biL=${biL?.sales?.total}`);
  }

  // ── [2] Warehouse sales included (#37) ────────────────────────────────────
  console.log("\n[2] /dashboard/summary includes warehouse sales (#37)");
  const [dbSum] = await q(
    `SELECT COALESCE(SUM(total_amount::numeric),0)::float AS total, COUNT(*)::int AS n
       FROM sales WHERE branch_transfer_id IS NULL AND cancelled_at IS NULL`);
  const [whSum] = await q(
    `SELECT COALESCE(SUM(total_amount::numeric),0)::float AS total, COUNT(*)::int AS n
       FROM sales WHERE branch_transfer_id IS NULL AND cancelled_at IS NULL
        AND COALESCE(location_type,'outlet') = 'warehouse'`);
  assert(`Fixture check: warehouse sales exist in the data (${whSum.n} rows)`, whSum.n > 0,
    "no warehouse-located sales — the inclusion proof would be vacuous");
  const summary = (await get(`/dashboard/summary`)).data;
  assert("summary.totalSalesAmount == DB sum over ALL locations (incl. warehouses)",
    near(summary?.totalSalesAmount, dbSum.total),
    `summary=${summary?.totalSalesAmount} db=${dbSum.total} (warehouse share=${whSum.total})`);
  const regAll = (await get(`/reports/sales-register?from=${EPOCH}&to=${TODAY}`)).data;
  assert("summary.totalSalesAmount == all-time sales register total",
    near(summary?.totalSalesAmount, regAll?.totals?.total),
    `summary=${summary?.totalSalesAmount} reg=${regAll?.totals?.total}`);

  const biAll = (await get(`/dashboard/bi?fromDate=${EPOCH}&toDate=${TODAY}`)).data;
  const byLoc = biAll?.sales?.byLocation ?? [];
  const locSum = byLoc.reduce((s, l) => s + Number(l.total ?? 0), 0);
  assert("Σ bi.sales.byLocation == bi.sales.total",
    near(locSum, biAll?.sales?.total), `Σ=${round2(locSum)} total=${biAll?.sales?.total}`);
  if (whSum.n > 0) {
    assert("bi.sales.byLocation contains warehouse rows",
      byLoc.some((l) => l.locationType === "warehouse"),
      JSON.stringify(byLoc.map((l) => l.locationType)));
  }

  // ── [3] COGS / GP / NP tiles == the P&L's own summary ─────────────────────
  console.log("\n[3] COGS/GP/NP tiles == P&L summary (same range)");
  for (const [label, from, to] of [["month-to-date", monthStart, TODAY], ["all-time", EPOCH, TODAY]]) {
    const bi = (await get(`/dashboard/bi?fromDate=${from}&toDate=${to}`)).data;
    const fs = (await get(`/accounts/financial-statements?fromDate=${from}&toDate=${to}`)).data;
    const s = fs?.profitAndLoss?.summary;
    assert(`P&L summary present (${label})`, !!s, JSON.stringify(fs).slice(0, 120));
    if (!s) continue;
    assert(`bi.profit.cogs == P&L costOfGoodsSold (${label})`,
      near(bi?.profit?.cogs, s.costOfGoodsSold), `bi=${bi?.profit?.cogs} pl=${s.costOfGoodsSold}`);
    assert(`bi.profit.gross == P&L grossProfit (${label})`,
      near(bi?.profit?.gross, s.grossProfit), `bi=${bi?.profit?.gross} pl=${s.grossProfit}`);
    assert(`bi.profit.net == P&L netProfit (${label})`,
      near(bi?.profit?.net, s.netProfit), `bi=${bi?.profit?.net} pl=${s.netProfit}`);
  }

  // ── [4] Cash/Bank balance tiles == Cash Book / Bank Book ──────────────────
  console.log("\n[4] Cash/Bank tiles == Cash & Bank Book closings");
  const bi = (await get(`/dashboard/bi?fromDate=${TODAY}&toDate=${TODAY}`)).data;
  for (const [tile, path] of [["cash", "/reports/fin/cash"], ["bank", "/reports/fin/bank"]]) {
    const book = (await get(`${path}?from=${EPOCH}&to=${TODAY}`)).data;
    const accounts = book?.accounts ?? [];
    const closing = accounts.reduce((s, a) => {
      const c = a.closing ?? (Number(a.opening ?? 0) + Number(a.inflow ?? 0) - Number(a.outflow ?? 0));
      return s + Number(c);
    }, 0);
    assert(`bi.${tile}.balance == ${tile} book Σ account closings`,
      near(bi?.[tile]?.balance, closing),
      `tile=${bi?.[tile]?.balance} book=${round2(closing)} (${accounts.length} accounts)`);
  }
  const mf = bi?.moneyFlows;
  assert("moneyFlows totals are internally consistent",
    !!mf && near(mf.totalIn, mf.cashIn + mf.bankIn) && near(mf.totalOut, mf.cashOut + mf.bankOut),
    JSON.stringify(mf));

  // ── [5] Receivables tile == ageing report control figure ──────────────────
  console.log("\n[5] Receivables tile == ageing netDue (widget & drill target)");
  const aging = (await get(`/outstanding/receivables?asOf=${TODAY}`)).data;
  assert("bi.receivables.total == receivables ageing totals.netDue",
    near(bi?.receivables?.total, aging?.totals?.netDue),
    `tile=${bi?.receivables?.total} ageing=${aging?.totals?.netDue}`);

  // ── [6] Purchases tile == Purchase Register ───────────────────────────────
  console.log("\n[6] Purchases tile == Purchase Register (same range)");
  for (const [label, from, to] of ranges) {
    const biR = (await get(`/dashboard/bi?fromDate=${from}&toDate=${to}`)).data;
    const reg = (await get(`/reports/purchase-register?from=${from}&to=${to}`)).data;
    assert(`bi.purchases.total == purchase register total (${label})`,
      near(biR?.purchases?.total, reg?.totals?.total),
      `bi=${biR?.purchases?.total} reg=${reg?.totals?.total}`);
  }

  // ── [7] Expenses tile == P&L Direct + Indirect expenses ───────────────────
  console.log("\n[7] Expenses tile == P&L expense group totals (drill: #pl-expenses)");
  for (const [label, from, to] of [["month-to-date", monthStart, TODAY], ["all-time", EPOCH, TODAY]]) {
    const biR = (await get(`/dashboard/bi?fromDate=${from}&toDate=${to}`)).data;
    const fs = (await get(`/accounts/financial-statements?fromDate=${from}&toDate=${to}`)).data;
    const ex = fs?.profitAndLoss?.expenses;
    const plTotal = Number(ex?.directExpenses?.total ?? 0) + Number(ex?.indirectExpenses?.total ?? 0);
    assert(`bi.expenses.total == P&L direct+indirect (${label})`,
      near(biR?.expenses?.total, plTotal),
      `bi=${biR?.expenses?.total} pl=${round2(plTotal)}`);
    assert(`expenses breakdown sums to the tile (${label})`,
      near(Number(biR?.expenses?.salary ?? 0) + Number(biR?.expenses?.rent ?? 0) + Number(biR?.expenses?.other ?? 0),
        biR?.expenses?.total),
      JSON.stringify(biR?.expenses));
  }

  // ── [8] Payables tile == Balance Sheet liability lines ────────────────────
  console.log("\n[8] Payables tile == Balance Sheet lines (drill: #bs-liabilities)");
  const pay = bi?.payables ?? {};
  assert("allPayables == Suppliers + Salary + Rent (tile breakdown)",
    near(pay.allPayables, Number(pay.total ?? 0) + Number(pay.salaryPayable ?? 0) + Number(pay.rentPayable ?? 0)),
    JSON.stringify(pay));
  {
    const fs = (await get(`/accounts/financial-statements?toDate=${TODAY}`)).data;
    // Subtree lookup by ledger code inside the statement's own tree — a node's
    // balance already includes its descendants, so the first match is the line
    // the Balance Sheet displays.
    const findByCode = (nodes, code) => {
      for (const n of nodes ?? []) {
        if (n.code === code) return n;
        const hit = findByCode(n.children, code);
        if (hit) return hit;
      }
      return null;
    };
    const lia = fs?.balanceSheet?.liabilities;
    const roots = [
      ...(lia?.currentLiabilities?.children ?? []),
      ...(lia?.loans?.children ?? []),
      ...(lia?.capitalAccount?.children ?? []),
    ];
    for (const [label, code, tileVal] of [
      ["Suppliers (Sundry Creditors)", "SYS-CREDITORS", pay.total],
      ["Salary Payable", "STD-GRP-SAL-PAY", pay.salaryPayable],
      ["Rent Payable", "STD-GRP-RENT-PAY", pay.rentPayable],
    ]) {
      const node = findByCode(roots, code);
      // A missing node is only acceptable when the tile figure is 0 too (the
      // statement drops empty groups).
      assert(`${label} tile figure == Balance Sheet line`,
        node ? near(Math.abs(node.balance), Math.abs(tileVal ?? 0)) : Math.abs(tileVal ?? 0) < 0.01,
        `bs=${node?.balance} tile=${tileVal}`);
    }
  }

  // ── [9] Payments/Receipts tiles == combined Cash & Bank book ──────────────
  console.log("\n[9] Payments/Receipts tiles == Cash & Bank book totals");
  for (const [label, from, to] of [["today", TODAY, TODAY], ["month-to-date", monthStart, TODAY]]) {
    const biR = (await get(`/dashboard/bi?fromDate=${from}&toDate=${to}`)).data;
    const cb = (await get(`/reports/fin/cash-bank?from=${from}&to=${to}`)).data;
    assert(`moneyFlows.totalIn == cash-bank book totalReceipts (${label})`,
      near(biR?.moneyFlows?.totalIn, cb?.totalReceipts),
      `tile=${biR?.moneyFlows?.totalIn} book=${cb?.totalReceipts}`);
    assert(`moneyFlows.totalOut == cash-bank book totalPayments (${label})`,
      near(biR?.moneyFlows?.totalOut, cb?.totalPayments),
      `tile=${biR?.moneyFlows?.totalOut} book=${cb?.totalPayments}`);
    // The combined book must be exactly the union of the two single books.
    const cash = (await get(`/reports/fin/cash?from=${from}&to=${to}`)).data;
    const bank = (await get(`/reports/fin/bank?from=${from}&to=${to}`)).data;
    assert(`cash-bank book == cash book + bank book (${label})`,
      near(cb?.totalReceipts, Number(cash?.totalReceipts ?? 0) + Number(bank?.totalReceipts ?? 0)) &&
      near(cb?.totalPayments, Number(cash?.totalPayments ?? 0) + Number(bank?.totalPayments ?? 0)),
      `cb=${cb?.totalReceipts}/${cb?.totalPayments} cash=${cash?.totalReceipts}/${cash?.totalPayments} bank=${bank?.totalReceipts}/${bank?.totalPayments}`);
  }

  // ── [10] Inventory tile == Stock Valuation report ─────────────────────────
  console.log("\n[10] Inventory tile == Stock Valuation grandTotal");
  const val = (await get(`/stock/valuation`)).data;
  const biNow = (await get(`/dashboard/bi?fromDate=${TODAY}&toDate=${TODAY}`)).data;
  assert("bi.inventory.valuation == /stock/valuation grandTotal",
    near(biNow?.inventory?.valuation, val?.grandTotal),
    `tile=${biNow?.inventory?.valuation} report=${val?.grandTotal}`);

} finally {
  await teardownUser();
  await sql.end();
}

console.log(`\n${"─".repeat(60)}\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
