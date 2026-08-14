/**
 * Employee advances → Salary Payable (Aug 2026 model) — task acceptance suite.
 *
 * The old Employee-Advance Current-Asset flow is retired: a new advance is a
 * PAYMENT VOUCHER (Dr employee Salary Payable / Cr till), payroll settles it
 * as a Salary Payable balance offset, and the one-time boot migration moved
 * every outstanding ADV-EMP balance onto Salary Payable and deactivated the
 * ADV-EMP subtree. Disposable fixtures only — creates its own employee,
 * restores company settings, cleans up fully and proves the book stayed
 * balanced afterwards.
 */
const BASE = "http://localhost:8080/api";
let TOKEN = "";

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}${detail ? `\n        ${detail}` : ""}`);
}
const near = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`); e.status = r.status; throw e; }
  return json;
}
async function tryApi(method, path, body) {
  try { return { ok: true, data: await api(method, path, body) }; }
  catch (e) { return { ok: false, status: e.status, error: String(e.message) }; }
}

// ── Direct SQL for verification (setup only where no API can exist) ────────
import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const Y = 2026, M = 7; // fixture month: July 2026 (fully in the past, unlocked)
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const SALARY = 30000, ALLOW = 4;
const DIM = new Date(Y, M, 0).getDate(); // basis = calendar days (Aug 2026 change)
const TODAY = new Date().toISOString().split("T")[0];

async function bookGap() {
  const [t] = await q(`SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS gap FROM journal_voucher_lines`);
  return Number(t.gap);
}

/**
 * Effective balance of a ledger the way the books derive it: journal lines
 * plus payment vouchers (Dr paid_to / Cr paid_from) plus receipts.
 * Positive = debit balance.
 */
async function ledgerBalance(ledgerId) {
  const [r] = await q(
    `SELECT
       COALESCE((SELECT SUM(debit)-SUM(credit) FROM journal_voucher_lines WHERE ledger_id=$1),0)
     + COALESCE((SELECT SUM(amount)  FROM payments WHERE paid_to_ledger_id=$1),0)
     - COALESCE((SELECT SUM(amount)  FROM payments WHERE paid_from_ledger_id=$1),0)
     + COALESCE((SELECT SUM(amount)  FROM receipts WHERE received_in_ledger_id=$1),0)
     - COALESCE((SELECT SUM(amount)  FROM receipts WHERE received_from_ledger_id=$1),0) AS bal`,
    [ledgerId]);
  return Number(r.bal);
}

let savedGS = null;
async function putGS(patch) {
  const cur = (await api("GET", "/company/settings")).generalSettings ?? {};
  return api("PATCH", "/company/settings", { generalSettings: { ...cur, ...patch } });
}

async function main() {
  TOKEN = (await api("POST", "/auth/login", {
    username: process.env.TEST_ADMIN_USER || process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_ADMIN_PASSWORD || process.env.TEST_PASSWORD || "marlin1458",
  })).token;

  savedGS = (await api("GET", "/company/settings")).generalSettings ?? {};
  await putGS({ paidCasualLeavesPerMonth: ALLOW, lopEnabled: true });

  // ── 1. One-time migration: guarded, reconciled, archived ────────────────
  const marker = await q(`SELECT COUNT(*)::int AS n FROM migration_log WHERE name='employee_advances_to_salary_payable_v1'`);
  check("M1", "Migration marker present exactly once (guard on migration_log)",
    marker[0].n === 1, `rows=${marker[0].n}`);

  const advActive = await q(
    `SELECT code FROM account_ledgers
      WHERE (code ~ '^ADV-EMP-[0-9]+$' OR code='STD-GRP-EMP-ADV') AND COALESCE(is_active, TRUE)`);
  check("M2", "ADV-EMP ledgers and their group are deactivated (hidden from pickers)",
    advActive.length === 0, advActive.map((r) => r.code).join(", "));

  const advNonzero = await q(
    `SELECT al.code, COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) AS bal
       FROM account_ledgers al LEFT JOIN journal_voucher_lines l ON l.ledger_id=al.id
      WHERE al.code ~ '^ADV-EMP-[0-9]+$' GROUP BY al.code
     HAVING ABS(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0)) > 0.004`);
  check("M3", "Every ADV-EMP ledger nets to zero (balances transferred, originals kept)",
    advNonzero.length === 0, advNonzero.map((r) => `${r.code}=${r.bal}`).join(", "));

  const gap0 = await bookGap();
  check("M4", "Trial balance still balances after the migration", near(gap0, 0, 0.02), `gap=${gap0}`);

  const migJv = await q(
    `SELECT COUNT(*)::int AS n FROM journal_vouchers WHERE narration LIKE '%one-time migration, original entries preserved%'`);
  check("M5", "Audited transfer voucher(s) exist for the migration", migJv[0].n >= 1, `vouchers=${migJv[0].n}`);

  // Every still-pending legacy row must carry per-row proof its balance was
  // moved (migrated_voucher_id → the transfer JV), and that JV must post the
  // row's amount on the employee's Salary Payable. A global marker is not
  // evidence for any individual row.
  const unconfirmed = await q(
    `SELECT id FROM employee_advances WHERE is_deducted = FALSE AND payment_voucher_id IS NULL AND migrated_voucher_id IS NULL`);
  check("M6", "Every pending legacy advance row is stamped with its transfer voucher",
    unconfirmed.length === 0, unconfirmed.map((r) => `#${r.id}`).join(", "));
  const badStamp = await q(
    `SELECT ea.id FROM employee_advances ea
      JOIN journal_vouchers v ON v.id = ea.migrated_voucher_id
     WHERE ea.is_deducted = FALSE AND ea.payment_voucher_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM journal_voucher_lines l
           JOIN account_ledgers al ON al.id = l.ledger_id
          WHERE l.voucher_id = v.id AND al.code = 'SAL-PAY-' || ea.employee_id AND l.debit > 0)`);
  check("M7", "Each stamp points at a real Dr-Salary-Payable transfer voucher",
    badStamp.length === 0, badStamp.map((r) => `#${r.id}`).join(", "));

  // ── 2. Fixture employee ─────────────────────────────────────────────────
  const hiers = await api("GET", "/hr/hierarchies");
  const stamp = Date.now();
  const emp = await api("POST", "/hr/employees", {
    name: `AdvTest_${stamp}`, username: `advtest_${stamp}`,
    email: `adv${stamp}@test.local`, phone: "9000000002",
    hierarchyId: hiers[0]?.id, branchType: "headoffice", branchId: 1,
    salary: SALARY, joinDate: D(1),
  });
  const EID = emp.id;
  console.log(`\nfixture employee #${EID} — ₹${SALARY}/month, joined ${D(1)}\n`);
  // Cover EVERY calendar day: a gap day would now be an unclassified absence
  // (blocking approval) and an LOP day (shrinking gross below ₹30,000).
  for (let d = 1; d <= DIM; d++) await api("PUT", "/hr/attendance", { employeeId: EID, date: D(d), status: "present" });

  const [salPay] = await q(`SELECT id FROM account_ledgers WHERE code=$1`, [`SAL-PAY-${EID}`]);

  // ── 3. New advance = payment voucher against Salary Payable ─────────────
  const adv = await api("POST", "/hr/advances", { employeeId: EID, amount: 3000, date: TODAY, note: "test advance" });
  check("A1", "Advance responds with a linked payment voucher", Number(adv.paymentVoucherId) > 0,
    `paymentVoucherId=${adv.paymentVoucherId}`);

  const [pv] = await q(`SELECT * FROM payments WHERE id=$1`, [adv.paymentVoucherId]);
  const [salPay2] = await q(`SELECT id FROM account_ledgers WHERE code=$1`, [`SAL-PAY-${EID}`]);
  check("A2", "Voucher: Dr Salary Payable / amount / provenance stamped",
    pv && Number(pv.paid_to_ledger_id) === Number(salPay2?.id) && near(pv.amount, 3000) && pv.source === "employee_advance",
    pv ? `paid_to=${pv.paid_to_ledger_id} salPay=${salPay2?.id} amt=${pv.amount} source=${pv.source}` : "voucher missing");
  const [pvFrom] = await q(
    `SELECT al.code FROM account_ledgers al WHERE al.id = $1`, [pv?.paid_from_ledger_id]);
  check("A3", "Voucher credits a cash/bank till", !!pvFrom, `paid_from=${pvFrom?.code ?? "?"}`);

  const advLedger = await q(`SELECT id FROM account_ledgers WHERE code=$1`, [`ADV-EMP-${EID}`]);
  check("A4", "No Employee-Advance asset ledger is created any more", advLedger.length === 0,
    advLedger.length ? `ADV-EMP-${EID} exists` : "");

  const salPayBal1 = await ledgerBalance(salPay2.id);
  check("A5", "Salary Payable driven negative (Dr) by the advance", near(salPayBal1, 3000),
    `balance=${salPayBal1}`);

  // Manual voucher endpoints must refuse this system-owned voucher.
  const manualDel = await tryApi("DELETE", `/accounts/payments/${adv.paymentVoucherId}`);
  check("A6", "Manual voucher DELETE refuses the advance voucher (provenance lock)",
    !manualDel.ok, manualDel.ok ? "deleted a system voucher!" : `status=${manualDel.status}`);

  // ── 4. Edit keeps the voucher in lockstep ────────────────────────────────
  await api("PATCH", `/hr/advances/${adv.id}`, { amount: 4000, date: TODAY, note: "test advance edited" });
  const [pvAfter] = await q(`SELECT amount, payment_date::text AS d FROM payments WHERE id=$1`, [adv.paymentVoucherId]);
  check("B1", "PATCH updates the payment voucher in lockstep", near(pvAfter?.amount, 4000) && pvAfter?.d === TODAY,
    `amount=${pvAfter?.amount} date=${pvAfter?.d}`);

  // ── 5. Recovery workflow is retired ─────────────────────────────────────
  const rec = await tryApi("POST", `/hr/advances/${adv.id}/recover`, {});
  check("C1", "POST /hr/advances/:id/recover is gone (404)", !rec.ok && rec.status === 404, `status=${rec.status}`);

  // ── 6. Unconfirmed legacy row (swallowed-JV case) blocks approval ───────
  // The old create path inserted the advance row BEFORE its voucher and
  // swallowed voucher failures — such a row has no ledger debit anywhere, and
  // no migrated_voucher_id stamp. Approval must refuse to settle it and leave
  // zero residue on Salary Payable; a global migration marker is not proof.
  const [ghost] = await q(
    `INSERT INTO employee_advances (employee_id, amount, date, note, is_deducted)
     VALUES ($1, 100, $2, 'fabricated pre-migration row with no voucher', FALSE) RETURNING id`, [EID, TODAY]);
  const ghostRows = await api("POST", "/hr/payroll/generate", { month: M, year: Y, employeeId: EID, forceRegenerate: true });
  const ghostRow = ghostRows.find((r) => Number(r.employeeId) === EID);
  check("H1", "Generate still sums the unconfirmed row into the draft (visible, not hidden)",
    near(ghostRow.advanceDeduction, 4100), `advanceDeduction=${ghostRow.advanceDeduction}`);
  const balBeforeGhost = await ledgerBalance(salPay2.id);
  const [jvCountBefore] = await q(`SELECT COUNT(*)::int AS n FROM journal_vouchers`);
  const ghostApprove = await tryApi("POST", `/hr/payroll/${ghostRow.id}/approve`, {});
  check("H2", "Approval refuses the unconfirmed legacy claim",
    !ghostApprove.ok && /no confirmed transferred balance/i.test(ghostApprove.error),
    ghostApprove.ok ? "approved money the books never received!" : "");
  const balAfterGhost = await ledgerBalance(salPay2.id);
  const [jvCountAfter] = await q(`SELECT COUNT(*)::int AS n FROM journal_vouchers`);
  const [ghostPr] = await q(`SELECT status FROM payroll WHERE id=$1`, [ghostRow.id]);
  check("H3", "Failed approval leaves NO residue (Salary Payable, vouchers, status untouched)",
    near(balAfterGhost, balBeforeGhost) && jvCountAfter.n === jvCountBefore.n && ghostPr?.status === "draft",
    `bal ${balBeforeGhost}→${balAfterGhost} jv ${jvCountBefore.n}→${jvCountAfter.n} status=${ghostPr?.status}`);
  await q(`DELETE FROM employee_advances WHERE id=$1`, [ghost.id]);

  // ── 7. Payroll settles the advance via Salary Payable ───────────────────
  const rows = await api("POST", "/hr/payroll/generate", { month: M, year: Y, employeeId: EID, forceRegenerate: true });
  const row = rows.find((r) => Number(r.employeeId) === EID);
  check("D1", "Generate deducts the advance (gross − advance = net)",
    near(row.advanceDeduction, 4000) && near(Number(row.netPay), Number(row.grossPay) - 4000 - Number(row.pfEmployee ?? 0) - Number(row.esiEmployee ?? 0) - Number(row.otherDeductions ?? 0)),
    `gross=${row.grossPay} advance=${row.advanceDeduction} net=${row.netPay}`);

  await api("POST", `/hr/payroll/${row.id}/approve`, {});
  const [advRow] = await q(`SELECT is_deducted, deducted_payroll_id FROM employee_advances WHERE id=$1`, [adv.id]);
  check("D2", "Advance closed by the approval (one settlement path)",
    advRow?.is_deducted === true && Number(advRow?.deducted_payroll_id) === Number(row.id),
    `is_deducted=${advRow?.is_deducted} payroll=${advRow?.deducted_payroll_id}`);

  const approvalJv = await q(
    `SELECT al.code, SUM(l.debit) AS dr, SUM(l.credit) AS cr
       FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id
       JOIN account_ledgers al ON al.id=l.ledger_id
      WHERE v.narration LIKE $1 AND al.code ~ '^ADV-EMP'
      GROUP BY al.code`, [`%AdvTest_${stamp}%`]);
  check("D3", "Approval posts NO Employee-Advance leg", approvalJv.length === 0,
    approvalJv.map((r) => r.code).join(", "));

  // After approval the payable must hold exactly the cash still owed: net pay.
  const salPayBal2 = await ledgerBalance(salPay2.id);
  check("D4", "Salary Payable balance after approval = net pay owed (advance offset)",
    near(salPayBal2, -Number(row.netPay), 0.05),
    `balance=${salPayBal2} expected=${-Number(row.netPay)}`);

  // ── 7. Paying the payroll zeroes the payable ─────────────────────────────
  await api("POST", `/hr/payroll/${row.id}/pay`, {});
  const salPayBal3 = await ledgerBalance(salPay2.id);
  check("E1", "Salary Payable nets to zero once paid", near(salPayBal3, 0, 0.05), `balance=${salPayBal3}`);

  // ── 8. Delete unwinds voucher + row together ─────────────────────────────
  const adv2 = await api("POST", "/hr/advances", { employeeId: EID, amount: 500, date: TODAY });
  await api("DELETE", `/hr/advances/${adv2.id}`);
  const [pv2] = await q(`SELECT id FROM payments WHERE id=$1`, [adv2.paymentVoucherId]);
  const [advRow2] = await q(`SELECT id FROM employee_advances WHERE id=$1`, [adv2.id]);
  check("F1", "DELETE removes the advance and its payment voucher together",
    !pv2 && !advRow2, `voucher=${pv2 ? "left" : "gone"} row=${advRow2 ? "left" : "gone"}`);

  // ── 9. Pending legacy rows are locked (their balance was migrated) ──────
  const [legacy] = await q(
    `INSERT INTO employee_advances (employee_id, amount, date, note, is_deducted)
     VALUES ($1, 100, $2, 'fabricated legacy row for lock test', FALSE) RETURNING id`, [EID, TODAY]);
  const legEdit = await tryApi("PATCH", `/hr/advances/${legacy.id}`, { amount: 200 });
  const legDel  = await tryApi("DELETE", `/hr/advances/${legacy.id}`);
  check("G1", "Legacy pending advance refuses edit", !legEdit.ok && /old Employee Advance/i.test(legEdit.error), legEdit.ok ? "edited!" : "");
  check("G2", "Legacy pending advance refuses delete", !legDel.ok && /old Employee Advance/i.test(legDel.error), legDel.ok ? "deleted!" : "");
  const advList = await api("GET", "/hr/advances");
  const legInList = advList.find((a) => Number(a.id) === Number(legacy.id));
  check("G3", "History list still serves legacy rows (with the lock flag)",
    !!legInList && legInList.paymentVoucherId == null, legInList ? "" : "row missing from list");
  await q(`DELETE FROM employee_advances WHERE id=$1`, [legacy.id]);

  await cleanup(EID, `AdvTest_${stamp}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

/** Remove every trace of the fixture and prove the book is still balanced. */
async function cleanup(empId, empName) {
  await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM payroll WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM pay_components WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM employee_advances WHERE employee_id=$1`, [empId]);
  // Vouchers whole or not at all: lines first, then heads.
  const jvs = await q(`SELECT id FROM journal_vouchers WHERE narration LIKE $1`, [`%${empName}%`]);
  for (const v of jvs) {
    await q(`DELETE FROM journal_voucher_lines WHERE voucher_id=$1`, [v.id]);
    await q(`DELETE FROM journal_vouchers WHERE id=$1`, [v.id]);
  }
  // Payment vouchers the fixture produced: advance disbursements + salary pay.
  const ledgers = await q(`SELECT id FROM account_ledgers WHERE code IN ($1,$2,$3)`,
    [`SAL-EMP-${empId}`, `SAL-PAY-${empId}`, `ADV-EMP-${empId}`]);
  const lids = ledgers.map((r) => r.id);
  if (lids.length) {
    await q(`DELETE FROM payments WHERE paid_to_ledger_id = ANY($1::int[]) OR paid_from_ledger_id = ANY($1::int[])`, [lids]);
  }
  await q(`DELETE FROM account_ledgers WHERE code IN ($1,$2,$3)`,
    [`SAL-EMP-${empId}`, `SAL-PAY-${empId}`, `ADV-EMP-${empId}`]);
  await q(`DELETE FROM employees WHERE id=$1`, [empId]).catch(() => {});
  await putGS(savedGS ?? {});
  const gap = await bookGap();
  console.log(Math.abs(gap) < 0.02
    ? "cleanup left the voucher book balanced"
    : `WARNING: cleanup left the voucher book off by ₹${gap}`);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await sql.end().catch(() => {});
  process.exit(1);
});
