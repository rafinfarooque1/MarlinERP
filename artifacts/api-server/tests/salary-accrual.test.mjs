/**
 * §18 test cases A–N for attendance-driven salary accrual.
 * Disposable fixtures only — creates its own employee, cleans up at the end.
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
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return json;
}
async function tryApi(method, path, body) {
  try { return { ok: true, data: await api(method, path, body) }; }
  catch (e) { return { ok: false, error: String(e.message) }; }
}

// ── Direct SQL for verification (never for setup) ─────────────────────────
import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

// Fixture month = the CURRENT month. Attendance-driven accrual pricing only
// covers dates from the cutover (salary_accrual_config.attendance_from)
// forward and never restates months before it, so a hardcoded past month
// reads accrual ₹0 forever (lop-payroll pins that no-restatement contract).
// The engine prices days through TODAY inclusive; future attendance rows are
// accepted but stay unpriced until their day arrives.
const NOW = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const Y = NOW.getFullYear(), M = NOW.getMonth() + 1, DOM = NOW.getDate();
// Working-days basis = the payroll month's actual calendar length (Aug 2026
// change — the payrollWorkingDays setting is retired).
const DIM = new Date(Y, M, 0).getDate();
const RATE = 30000 / DIM; // fixture A–H: ₹30,000/month over DIM calendar days
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
if (DOM < 7) {
  // Scenarios A–F walk days 1..7 of the month and need them all priced.
  console.log(`SKIP: day-of-month ${DOM} < 7 — accrual prices only through today, so days 1..7 of the current month must exist. Re-run on/after the 7th.`);
  process.exit(0);
}
// Approval and payment vouchers are dated the day the test RUNS; every ledger
// read must extend to at least month-end or today, whichever is later.
const TODAY = new Date().toLocaleDateString("en-CA");
const EOM = new Date(Date.UTC(Y, M, 0)).getUTCDate();
const END = TODAY > D(EOM) ? TODAY : D(EOM);

async function accrualTotal(empId) {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS rows,
            COUNT(*) FILTER (WHERE amount > 0.004) AS earning
       FROM salary_accruals WHERE employee_id=$1 AND year=$2 AND month=$3`,
    [empId, Y, M]);
  return { total: Number(r.total), rows: Number(r.rows), earning: Number(r.earning) };
}
async function ledgerBalance(code) {
  const [r] = await q(
    `SELECT COALESCE(SUM(debit),0) AS dr, COALESCE(SUM(credit),0) AS cr
       FROM (SELECT 0 AS debit, 0 AS credit) z WHERE FALSE`);
  return r;
}

async function main() {
  TOKEN = (await api("POST", "/auth/login", {
    username: process.env.TEST_ADMIN_USER || process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_ADMIN_PASSWORD || process.env.TEST_PASSWORD || "marlin1458",
  })).token;

  // The leave policy is COMPANY policy since the Aug 2026 LOP change. Pin the
  // values every expectation below assumes, restore at the end. (The
  // working-days basis is no longer a setting — it is the calendar month.)
  await pinPolicy({ paidCasualLeavesPerMonth: 4, lopEnabled: true });

  const hiers = await api("GET", "/hr/hierarchies");
  const hierarchyId = hiers[0]?.id;
  const stamp = Date.now();

  // Salary 30000 over the month's DIM calendar days = ₹RATE/day.
  const emp = await api("POST", "/hr/employees", {
    name: `AccrualTest_${stamp}`, username: `acctest_${stamp}`,
    email: `acc${stamp}@test.local`, phone: "9000000000",
    hierarchyId, branchType: "headoffice", branchId: 1,
    salary: 30000, joinDate: D(1),
  });
  const EID = emp.id;
  console.log(`\nfixture employee #${EID} — ₹30,000/month, joined ${D(1)}\n`);

  const setAtt = (day, status) => api("PUT", "/hr/attendance", { employeeId: EID, date: D(day), status });

  // ── A. Full day ─────────────────────────────────────────────────────────
  await setAtt(1, "present");
  let t = await accrualTotal(EID);
  check("A", "Full day earns exactly one day's salary",
    near(t.total, round2(RATE)) && t.earning === 1,
    `accrued ₹${t.total} over ${t.earning} earning day(s); expected ₹${round2(RATE)} / 1`);

  // ── B. Half day ─────────────────────────────────────────────────────────
  // Under the leave policy a half day is half worked + half a casual leave;
  // while the monthly allowance (4) lasts, the leave half is PAID, so the day
  // still earns a full day's rate. (Unpaid halves are the LOP suite's job.)
  await setAtt(2, "half_day");
  t = await accrualTotal(EID);
  check("B", "Half day tops up from the paid-leave allowance to a full day",
    near(t.total, round2(2 * RATE)),
    `accrued ₹${t.total}; expected ₹${round2(2 * RATE)} (2 full days: half worked + half paid leave)`);

  // ── C. Absent / LOP ─────────────────────────────────────────────────────
  await setAtt(3, "absent");
  t = await accrualTotal(EID);
  const [absRow] = await q(
    `SELECT amount, attendance_basis FROM salary_accruals WHERE employee_id=$1 AND accrual_date=$2`,
    [EID, D(3)]);
  check("C", "Absent day accrues nothing",
    near(t.total, round2(2 * RATE)) && near(absRow?.amount ?? -1, 0),
    `month total ₹${t.total} (unchanged); day row = ₹${absRow?.amount} basis '${absRow?.attendance_basis}'`);

  // ── D. Full day → absent correction ─────────────────────────────────────
  const beforeD = await q(
    `SELECT COUNT(*) AS n FROM salary_accruals WHERE employee_id=$1 AND accrual_date=$2`, [EID, D(1)]);
  await setAtt(1, "absent");
  t = await accrualTotal(EID);
  const afterD = await q(
    `SELECT COUNT(*) AS n, SUM(amount) AS amt FROM salary_accruals WHERE employee_id=$1 AND accrual_date=$2`,
    [EID, D(1)]);
  check("D", "Full→absent correction adjusts in place, never duplicates",
    near(t.total, round2(RATE)) && Number(afterD[0].n) === 1 && Number(beforeD[0].n) === 1,
    `month total ₹${t.total} (expected ₹${round2(RATE)}); rows for ${D(1)}: ${beforeD[0].n} → ${afterD[0].n} (must stay 1), value ₹${afterD[0].amt}`);
  await setAtt(1, "present"); // put the day back

  // ── E. Absent → present correction ──────────────────────────────────────
  await setAtt(3, "present");
  t = await accrualTotal(EID);
  check("E", "Absent→present correction recognises the extra earned salary",
    near(t.total, round2(3 * RATE)),
    `month total ₹${t.total}; expected ₹${round2(3 * RATE)} (3 full days)`);

  // ── F. Multiple days: accrual == payroll ────────────────────────────────
  await setAtt(6, "present");
  await setAtt(7, "present");
  t = await accrualTotal(EID);
  const gen = await api("POST", "/hr/payroll/generate", { year: Y, month: M });
  const payrollList = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
  let row = (Array.isArray(payrollList) ? payrollList : payrollList.data ?? [])
    .find((p) => Number(p.employeeId) === EID);
  const earnedBasic = Math.round((Number(row?.baseSalary ?? 0) - Number(row?.lopDeduction ?? 0)) * 100) / 100;
  check("F", "Accrued Salary Expense equals payroll's earned basic",
    row && near(t.total, earnedBasic),
    `accrued ₹${t.total} vs payroll earned basic ₹${earnedBasic} (base ${row?.baseSalary} − LOP ${row?.lopDeduction}); presentDays=${row?.presentDays}, LOP days=${row?.lopDays}`);

  // ── G. Payroll deduction → Net Payable ──────────────────────────────────
  const netPay = Number(row?.netPay ?? 0);
  const deductions = Number(row?.deductions ?? 0);
  const advDed = Number(row?.advanceDeduction ?? 0);
  const grossPay = Number(row?.grossPay ?? 0);
  check("G", "Net Payable = earned gross − deductions",
    near(netPay, grossPay - deductions - advDed + Number(row?.bonus ?? 0)),
    `gross ₹${grossPay} − deductions ₹${deductions} − advances ₹${advDed} + bonus ₹${row?.bonus ?? 0} = ₹${netPay}`);

  // ── H. Month-end approval must not duplicate the accrual ────────────────
  // The fixture deliberately leaves uncovered past days, which the approval
  // gate now surfaces as unclassified absences; this suite tests the accrual
  // true-up, not classification (payroll-autocalc covers that), so confirm
  // them as loss of pay explicitly.
  //
  // Approval also refuses any pay period with days that have not occurred yet
  // (MONTH_INCOMPLETE — they would freeze in as loss of pay). End the
  // fixture's employment today so its payable period is complete; the figures
  // are untouched — all attendance sits on days 1..7, well inside the cap.
  await api("PATCH", `/hr/employees/${EID}`, { employmentStatus: "resigned", lastWorkingDate: D(DOM) });
  const rowsH = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
  row = (Array.isArray(rowsH) ? rowsH : rowsH.data ?? []).find((p) => Number(p.employeeId) === EID);
  const payableBefore = await payableFor(EID);
  const expenseBefore = await expenseFor(EID);
  await api("POST", `/hr/payroll/${row.id}/approve`, { confirmLop: true });
  const payableAfter = await payableFor(EID);
  const expenseAfter = await expenseFor(EID);
  check("H", "Approval trues up to net pay instead of re-recognising the accrual",
    near(payableAfter, netPay),
    `Salary Payable ₹${payableBefore} → ₹${payableAfter}; net pay ₹${netPay}. `
    + `Expense ₹${expenseBefore} → ₹${expenseAfter} (accrued ₹${t.total}, not doubled to ₹${t.total * 2})`);

  // ── I / J. Payments ─────────────────────────────────────────────────────
  const part = Math.round(netPay / 2 * 100) / 100;
  await api("POST", `/hr/payroll/${row.id}/pay`, { amount: part, paymentMode: "cash" });
  const afterPartial = await payableFor(EID);
  check("J", "Partial payment leaves only the remainder payable",
    near(afterPartial, netPay - part),
    `paid ₹${part} of ₹${netPay}; Salary Payable now ₹${afterPartial}, expected ₹${Math.round((netPay - part) * 100) / 100}`);

  await api("POST", `/hr/payroll/${row.id}/pay`, { paymentMode: "cash" });
  const afterFull = await payableFor(EID);
  check("I", "Full payment clears Salary Payable to zero",
    near(afterFull, 0),
    `Salary Payable after settling in full = ₹${afterFull}`);

  // ── K. Manual journal against Salary Payable ────────────────────────────
  const [salPay] = await q(`SELECT id FROM account_ledgers WHERE code = $1`, [`SAL-PAY-${EID}`]);
  const [cashL] = await q(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`);
  const jv = await tryApi("POST", "/accounts/journal-vouchers", {
    voucherDate: TODAY, narration: `Accrual test manual adjustment #${stamp}`,
    lines: [
      { ledgerId: cashL.id, debit: 0, credit: 750, narration: "adj" },
      { ledgerId: salPay.id, debit: 0, credit: 0, narration: "adj" },
    ].map((l, i) => (i === 1 ? { ledgerId: salPay.id, debit: 750, credit: 0, narration: "adj" } : l)),
  });
  if (jv.ok) {
    const afterJv = await payableFor(EID);
    check("K", "Manual journal against Salary Payable moves the ledger balance",
      near(afterJv, -750),
      `Dr Salary Payable 750 → balance ₹${afterJv} (a debit balance, i.e. overpaid, is the honest result)`);
  } else {
    check("K", "Manual journal against Salary Payable moves the ledger balance", false, jv.error);
  }

  // ── L. Dashboard ────────────────────────────────────────────────────────
  const bi = await api("GET", "/dashboard/bi");
  const dashSalary = bi?.payables?.salaryPayable;
  const allSalPay = await q(
    `SELECT COALESCE(SUM(amount),0) AS t FROM (SELECT 0 AS amount) z WHERE FALSE`);
  const ledgerSalaryPayable = await totalSalaryPayable();
  check("L", "Dashboard Salary Payable agrees with the ledger",
    dashSalary != null && near(dashSalary, ledgerSalaryPayable, 1),
    `dashboard ₹${dashSalary} vs ledger ₹${ledgerSalaryPayable}; allPayables=₹${bi?.payables?.allPayables}, suppliers=₹${bi?.payables?.total}`);

  // ── M. P&L salary expense ───────────────────────────────────────────────
  const fs = await api("GET", `/accounts/financial-statements?fromDate=${D(1)}&toDate=${END}`);
  const pnlSalary = findLine(fs?.profitAndLoss, `Salary - ${emp.name}`);
  const empExpense = await expenseFor(EID);
  check("M", "P&L Salary Expense agrees with the posted salary expense",
    pnlSalary != null && near(pnlSalary, empExpense, 1),
    `P&L line ₹${pnlSalary} vs ledger ₹${empExpense}`);

  // ── N. Trial balance ────────────────────────────────────────────────────
  const tb = await api("GET", `/accounts/trial-balance?toDate=${END}`);
  const td = Number(tb?.totals?.debit ?? tb?.totalDebit ?? 0);
  const tc = Number(tb?.totals?.credit ?? tb?.totalCredit ?? 0);
  check("N", "Trial Balance still balances", near(td, tc, 0.5),
    `Dr ₹${td} = Cr ₹${tc}`);

  // ── Extra: locked month refuses correction (§8/§19) ─────────────────────
  const refused = await tryApi("PUT", "/hr/attendance", { employeeId: EID, date: D(10), status: "present" });
  check("O", "Attendance in an approved/paid month is refused, not silently ignored",
    !refused.ok && /already paid|already approved/i.test(refused.error),
    refused.ok ? "correction was ACCEPTED — locked month is editable" : refused.error.slice(0, 160));

  // ── Extra: idempotency (§17) ────────────────────────────────────────────
  const t1 = await accrualTotal(EID);
  await api("POST", "/hr/payroll/generate", { year: Y, month: M }).catch(() => {});
  const t2 = await accrualTotal(EID);
  check("P", "Re-running accrual changes nothing (idempotent)",
    near(t1.total, t2.total) && t1.rows === t2.rows,
    `₹${t1.total}/${t1.rows} rows → ₹${t2.total}/${t2.rows} rows`);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await cleanup(EID, emp.name);
  console.log(`cleaned up fixture employee #${EID}`);

  await roundingAndStalenessTests(hierarchyId);
  await raceTest(hierarchyId);

  await restorePolicy();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.id).join(", "));
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

/**
 * Q and R need a salary that does NOT divide evenly by the working-days basis
 * (the month's calendar length). ₹20,000 over a 28/30/31-day month never
 * divides cleanly, so rounding the rate before multiplying and rounding after
 * differ by paise — exactly the property under test.
 */
async function roundingAndStalenessTests(hierarchyId) {
  const stamp = Date.now();
  const emp = await api("POST", "/hr/employees", {
    name: `AccrualTest_R${stamp}`, username: `accr_${stamp}`,
    email: `accr${stamp}@test.local`, phone: "9000000001",
    hierarchyId, branchType: "headoffice", branchId: 1,
    salary: 20000, joinDate: D(1),
  });
  const EID = emp.id;
  console.log(`\nfixture employee #${EID} — ₹20,000/month over ${DIM} days = ₹${20000 / DIM}/day\n`);

  // 25 attended days out of the calendar-month basis; the rest is LOP.
  for (let d = 1; d <= 25; d++) {
    await api("PUT", "/hr/attendance", { employeeId: EID, date: D(d), status: "present" });
  }

  await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: EID });
  const rows = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
  const row = rows.find((r) => Number(r.employeeId) === EID);
  const earnedBasic = round2(Number(row?.baseSalary ?? 0) - Number(row?.lopDeduction ?? 0));

  const t = await accrualTotal(EID);
  // The engine prices only days that have arrived; the payroll figure covers
  // the whole month. The paisa property under test is that k priced days
  // total round2(k × rate) — cumulative rounding, never k independently
  // rounded days (which drifts). At month-end (k=25) that equals the payroll
  // earned basic exactly.
  const k = Math.min(DOM, 25);
  const expectedQ = k >= 25 ? earnedBasic : round2(k * (20000 / DIM));
  check("Q", "Accrual matches the cumulative daily rate to the paisa when it doesn't divide evenly",
    near(t.total, expectedQ, 0.005),
    `accrued ₹${t.total} vs expected ₹${expectedQ} (${k} priced day(s) × ₹20000/${DIM}, cumulative)` +
    `${near(t.total, expectedQ, 0.005) ? "" : "  ← rounding drift"}`);

  // Attendance moves after the payroll row was frozen. Approving now would true
  // up to a figure the attendance no longer supports.
  await api("PUT", "/hr/attendance", { employeeId: EID, date: D(26), status: "present" });
  const stale = await tryApi("POST", `/hr/payroll/${row.id}/approve`, {});
  check("R", "Approving a payroll that attendance has moved past is refused, not posted",
    !stale.ok && /changed after this payroll was generated/i.test(stale.error),
    stale.ok
      ? "approval was ACCEPTED against stale attendance"
      : stale.error.slice(0, 170));

  // Regenerating clears the staleness and approval then goes through.
  // Approval refuses pay periods with days that have not occurred yet
  // (MONTH_INCOMPLETE) — end this fixture's employment on its last attended
  // day so its payable period is complete. Every attended day is ≤ D(26), so
  // the figures the staleness check compares are untouched.
  await api("PATCH", `/hr/employees/${EID}`, { employmentStatus: "resigned", lastWorkingDate: D(26) });
  await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: EID, forceRegenerate: true });
  const after = await tryApi("POST", `/hr/payroll/${row.id}/approve`, {});
  check("S", "Regenerating clears the block and approval proceeds",
    after.ok, after.ok ? "approved after regenerate" : after.error.slice(0, 170));

  await cleanup(EID, emp.name);
  console.log(`cleaned up fixture employee #${EID}`);
}

/**
 * T — an attendance correction racing a payroll approval must not both win.
 *
 * Attendance decides what a day earns; approval posts the difference between the
 * frozen payroll figure and what has accrued. If a correction can commit between
 * approval's attendance read and its commit, the correction's re-accrual queues
 * behind the approval, finds the month approved, and skips — silently discarded
 * after the user was told salary had been recalculated.
 *
 * Both writers take the same per-employee lock, so one of two things must be
 * true afterwards: approval won and the correction was refused (month closed),
 * or the correction won and approval refused itself as stale. Never both.
 */
async function raceTest(hierarchyId) {
  console.log(`\nracing an attendance correction against payroll approval\n`);
  let violations = 0, bothFailed = 0, approvalWon = 0, correctionWon = 0;
  let closedMonthRefusals = 0, staleRefusals = 0;
  const ROUNDS = 6;

  for (let i = 0; i < ROUNDS; i++) {
    const stamp = `${Date.now()}_${i}`;
    const emp = await api("POST", "/hr/employees", {
      name: `AccrualTest_T${stamp}`, username: `accrt_${stamp}`,
      email: `accrt${stamp}@test.local`, phone: "9000000002",
      hierarchyId, branchType: "headoffice", branchId: 1,
      salary: 26000, joinDate: D(1),
    });
    // Attend every day up to yesterday, leave TODAY rowless as the racing
    // correction's target, and end employment today so the payable period is
    // complete — approval refuses incomplete periods (MONTH_INCOMPLETE)
    // outright, which would starve the approval side of the race.
    for (let d = 1; d < DOM; d++) {
      await api("PUT", "/hr/attendance", { employeeId: emp.id, date: D(d), status: "present" });
    }
    await api("PATCH", `/hr/employees/${emp.id}`, { employmentStatus: "resigned", lastWorkingDate: D(DOM) });
    await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: emp.id });
    const rows = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
    const row = rows.find((r) => Number(r.employeeId) === emp.id);

    // Fire both at once. Whichever grabs the lock first decides the outcome.
    // Alternate which one is dispatched first: issuing the correction first wins
    // the lock every time, which would leave the dangerous branch — approval
    // commits, correction must then be refused rather than silently dropped —
    // never exercised.
    // Dispatch order alone is not enough to flip the winner: approval loads the
    // payroll row, the employee and the ledgers before it reaches the lock, so a
    // correction fired at the same instant always gets there first. Odd rounds
    // give approval a head start so the correction lands while it holds the lock.
    // TODAY is the fixture's one rowless (unclassified) day, so approval must
    // carry confirmLop — otherwise winning the lock would still 409 and the
    // "approval won, correction refused" branch would never be exercised.
    const doCorrect = () => tryApi("PUT", "/hr/attendance", { employeeId: emp.id, date: D(DOM), status: "present" });
    const doApprove = () => tryApi("POST", `/hr/payroll/${row.id}/approve`, { confirmLop: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const [correct, approve] = i % 2 === 0
      ? await Promise.all([doCorrect(), doApprove()])
      : await (async () => {
          const a = doApprove();
          await sleep(25);
          const c = await doCorrect();
          return [c, await a];
        })();

    if (correct.ok && approve.ok) violations++;
    else if (!correct.ok && !approve.ok) bothFailed++;
    else if (approve.ok) {
      // Approval got there first, so the correction must have been turned away
      // because the month is now signed off — not lost, not accepted.
      approvalWon++;
      if (/already (approved|paid)/i.test(correct.error ?? "")) closedMonthRefusals++;
    } else {
      // The correction got there first, so approval must refuse itself as stale.
      correctionWon++;
      if (/changed after this payroll was generated/i.test(approve.error ?? "")) staleRefusals++;
    }

    await cleanup(emp.id, emp.name);
  }

  const oneWinnerEach = violations === 0 && bothFailed === 0;
  // Every loss must carry the right reason, or the guard is refusing by accident.
  const reasonsRight = closedMonthRefusals === approvalWon && staleRefusals === correctionWon;
  check("T", "An attendance correction and an approval cannot both win the race",
    oneWinnerEach && reasonsRight && approvalWon > 0 && correctionWon > 0,
    violations > 0
      ? `${violations}/${ROUNDS} round(s) let BOTH succeed — approval posted a figure attendance no longer supports`
      : bothFailed > 0
        ? `${bothFailed}/${ROUNDS} round(s) refused both — the lock is starving one side`
        : !reasonsRight
          ? `refusal reasons wrong: ${closedMonthRefusals}/${approvalWon} closed-month, ${staleRefusals}/${correctionWon} stale`
          : approvalWon === 0 || correctionWon === 0
            ? `only one ordering was exercised (approval won ${approvalWon}, correction won ${correctionWon})`
            : `${ROUNDS} rounds, exactly one winner each — approval won ${approvalWon} `
              + `(correction refused: month closed), correction won ${correctionWon} (approval refused: stale)`);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ── Company leave-policy pin/restore ────────────────────────────────────────
let savedGS = null;
async function pinPolicy(patch) {
  savedGS = (await api("GET", "/company/settings")).generalSettings ?? {};
  await api("PATCH", "/company/settings", { generalSettings: { ...savedGS, ...patch } });
}
async function restorePolicy() {
  if (savedGS) await api("PATCH", "/company/settings", { generalSettings: savedGS });
}

async function payableFor(empId) {
  const net = await ledgerNet(`SAL-PAY-${empId}`, -1);
  // The daily engine also accrues for TODAY's month (untracked = full
  // attendance), so a fixture that lives past its own month carries an extra
  // day or two of payable that the July-shaped expectations never see. Net
  // out everything outside the fixture month.
  const [r] = await q(
    `SELECT COALESCE(SUM(amount),0) AS t FROM salary_accruals
      WHERE employee_id=$1 AND NOT (year=$2 AND month=$3)`, [empId, Y, M]);
  return Math.round((net - Number(r.t)) * 100) / 100;
}
async function expenseFor(empId) { return await ledgerNet(`SAL-EMP-${empId}`, 1); }

/** Net balance of one ledger straight off the derived posting stream. */
async function ledgerNet(code, sign) {
  const r = await api("GET", `/accounts/ledger-balance-probe?code=${encodeURIComponent(code)}`)
    .catch(() => null);
  if (r && typeof r.net === "number") return Math.round(r.net * sign * 100) / 100;
  // No probe endpoint — fall back to the trial balance, which is the same stream.
  const tb = await api("GET", `/accounts/trial-balance?toDate=${END}`);
  const rows = tb?.rows ?? tb?.ledgers ?? [];
  const hit = rows.find((x) => x.code === code);
  if (!hit) return 0;
  return Math.round((Number(hit.debit ?? 0) - Number(hit.credit ?? 0)) * sign * 100) / 100;
}
async function totalSalaryPayable() {
  const tb = await api("GET", `/accounts/trial-balance?toDate=${END}`);
  const rows = tb?.rows ?? tb?.ledgers ?? [];
  let net = 0;
  for (const r of rows) if (/^SAL-PAY-\d+$/.test(r.code ?? "")) net += Number(r.credit ?? 0) - Number(r.debit ?? 0);
  return Math.round(net * 100) / 100;
}
function findLine(node, name) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findLine(n, name); if (f != null) return f; } return null; }
  if (node.name === name) { for (const k of ["balance","total","amount"]) if (typeof node[k] === "number") return node[k]; }
  for (const v of Object.values(node)) { const f = findLine(v, name); if (f != null) return f; }
  return null;
}

/**
 * Remove the fixture WITHOUT unbalancing the books.
 *
 * A voucher is deleted whole or not at all. Deleting `journal_voucher_lines` by
 * ledger id — the obvious way to "remove the test employee's postings" — strips
 * one leg off a balanced voucher and leaves the other behind, so the trial
 * balance ends up off by the value of the missing side. That failure looks
 * exactly like a bug in the code under test, which is the trap worth avoiding.
 */
async function cleanup(empId, empName) {
  await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM payroll WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM pay_components WHERE employee_id=$1`, [empId]);

  // Every voucher this fixture caused, named after it, removed lines-first.
  const vs = await q(
    `SELECT id FROM journal_vouchers WHERE narration LIKE $1 OR narration LIKE $2`,
    [`%${empName}%`, `%Accrual test manual adjustment%`]);
  for (const v of vs) {
    await q(`DELETE FROM journal_voucher_lines WHERE voucher_id=$1`, [v.id]);
    await q(`DELETE FROM journal_vouchers WHERE id=$1`, [v.id]);
  }

  await q(`DELETE FROM account_ledgers WHERE code IN ($1,$2)`,
    [`SAL-EMP-${empId}`, `SAL-PAY-${empId}`]).catch(() => {});
  await q(`DELETE FROM employees WHERE id=$1`, [empId]).catch(() => {});

  const [bal] = await q(
    `SELECT COALESCE(SUM(l.debit),0) dr, COALESCE(SUM(l.credit),0) cr
       FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id`);
  const gap = Math.round((Number(bal.dr) - Number(bal.cr)) * 100) / 100;
  console.log(gap === 0
    ? "cleanup left the voucher book balanced"
    : `WARNING: cleanup left the voucher book off by ₹${gap}`);
}

main().catch(async (e) => { console.error("\nHARNESS ERROR:", e); try { await sql.end(); } catch {} process.exit(2); });
