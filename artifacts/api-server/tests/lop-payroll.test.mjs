/**
 * Loss of Pay (LOP) + Payroll Settings — spec §11 test cases.
 *
 * Company-wide leave policy: per-day = salary / workingDays; casual leave paid
 * up to paidCasualLeavesPerMonth; half-day = 0.5 leave; beyond the allowance
 * each missing day is deducted; only the NET (post-LOP) salary reaches the
 * books. Disposable fixtures only — creates its own employee, restores the
 * company settings it touches, cleans up at the end.
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
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const Y = 2026, M = 7; // fixture month: July 2026 (fully in the past)
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const SALARY = 30000, WD = 30, ALLOW = 4; // per-day = ₹1,000 exactly

// Attendance-driven accrual pricing has a cutover date (salary_accrual_config.
// attendance_from). Months entirely BEFORE it are never (re)stated by design —
// restating history unprompted is exactly what the engine refuses to do. When
// the fixture month predates the cutover, the accrual checks pin THAT contract
// (accrual stays ₹0) instead of the live-pricing figures.
let PRE_CUTOVER = false;

async function accrualTotal(empId) {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount),0) AS total FROM salary_accruals
      WHERE employee_id=$1 AND year=$2 AND month=$3`, [empId, Y, M]);
  return Number(r.total);
}

let savedGS = null; // company generalSettings snapshot, restored at the end

async function putGS(patch) {
  const cur = (await api("GET", "/company/settings")).generalSettings ?? {};
  return api("PATCH", "/company/settings", { generalSettings: { ...cur, ...patch } });
}

async function generate(empId) {
  const rows = await api("POST", "/hr/payroll/generate",
    { month: M, year: Y, employeeId: empId, forceRegenerate: true });
  const row = rows.find((r) => Number(r.employeeId) === empId);
  if (!row) throw new Error("generate returned no row for fixture employee");
  return row;
}

async function main() {
  TOKEN = (await api("POST", "/auth/login", {
    username: process.env.TEST_ADMIN_USER || process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_ADMIN_PASSWORD || process.env.TEST_PASSWORD || "marlin1458",
  })).token;

  savedGS = (await api("GET", "/company/settings")).generalSettings ?? {};
  await putGS({ payrollWorkingDays: WD, paidCasualLeavesPerMonth: ALLOW, lopEnabled: true });

  const [cfg] = await q(`SELECT attendance_from FROM salary_accrual_config WHERE id = 1`);
  const cutover = cfg?.attendance_from ? new Date(cfg.attendance_from) : null;
  PRE_CUTOVER = !!cutover && new Date(Date.UTC(Y, M, 0)) < cutover; // fixture month ends before pricing began
  if (PRE_CUTOVER) console.log(`fixture month ${Y}-${M} predates the accrual pricing cutover — accrual checks pin the no-restatement contract (₹0)\n`);

  // ── 1. Settings validation ────────────────────────────────────────────
  const v1 = await tryApi("PATCH", "/company/settings", { generalSettings: { ...savedGS, payrollWorkingDays: 0 } });
  check("V1", "Working days 0 rejected", !v1.ok && /between 1 and 31/i.test(v1.error), v1.ok ? "accepted!" : "");
  const v2 = await tryApi("PATCH", "/company/settings", { generalSettings: { ...savedGS, payrollWorkingDays: 32 } });
  check("V2", "Working days 32 rejected", !v2.ok && /between 1 and 31/i.test(v2.error), v2.ok ? "accepted!" : "");
  const v3 = await tryApi("PATCH", "/company/settings", { generalSettings: { ...savedGS, payrollWorkingDays: 30, paidCasualLeavesPerMonth: 31 } });
  check("V3", "Paid leaves > working days rejected", !v3.ok && /cannot exceed/i.test(v3.error), v3.ok ? "accepted!" : "");
  const v4 = await tryApi("PATCH", "/company/settings", { generalSettings: { ...savedGS, lopEnabled: "yes" } });
  check("V4", "Non-boolean LOP toggle rejected", !v4.ok, v4.ok ? "accepted!" : "");
  // validation attempts must not have changed the effective policy
  await putGS({ payrollWorkingDays: WD, paidCasualLeavesPerMonth: ALLOW, lopEnabled: true });

  // ── Fixture employee: ₹30,000 over 30 working days = ₹1,000/day ────────
  const hiers = await api("GET", "/hr/hierarchies");
  const stamp = Date.now();
  const emp = await api("POST", "/hr/employees", {
    name: `LopTest_${stamp}`, username: `loptest_${stamp}`,
    email: `lop${stamp}@test.local`, phone: "9000000001",
    hierarchyId: hiers[0]?.id, branchType: "headoffice", branchId: 1,
    salary: SALARY, joinDate: D(1),
  });
  const EID = emp.id;
  console.log(`\nfixture employee #${EID} — ₹${SALARY}/month, joined ${D(1)}\n`);

  const setAtt = (day, status) => api("PUT", "/hr/attendance", { employeeId: EID, date: D(day), status });

  // ── 2. Scenario A — 4 leaves, all inside the allowance → full salary ───
  // July has 31 days: 26 present + 4 leave + 1 absent → worked 26 + paid
  // leave 4 = payable 30 of 30 → LOP 0.
  for (let d = 1; d <= 26; d++) await setAtt(d, "present");
  for (let d = 27; d <= 30; d++) await setAtt(d, "leave");
  await setAtt(31, "absent");

  let row = await generate(EID);
  check("A1", "4 leaves within allowance → no LOP",
    Number(row.lopDays) === 0 && near(row.lopDeduction, 0),
    `lopDays=${row.lopDays} lopDeduction=${row.lopDeduction}`);
  check("A2", "Full basic pay (₹30,000 gross)", near(row.grossPay, SALARY), `gross=${row.grossPay}`);
  check("A3", "Paid leave snapshot 4 used / 4 allowed",
    near(row.paidLeaveUsed, 4) && near(row.paidLeaveAllowed, ALLOW),
    `used=${row.paidLeaveUsed} allowed=${row.paidLeaveAllowed}`);
  let acc = await accrualTotal(EID);
  check("A4", PRE_CUTOVER ? "Pre-cutover month is never restated (accrual ₹0)" : "Daily accrual agrees with payroll (₹30,000)",
    near(acc, PRE_CUTOVER ? 0 : SALARY, 0.05), `accrued=${acc}`);

  // ── 3. Scenario B — 5th leave becomes 1 LOP day (₹1,000) ────────────────
  await setAtt(26, "leave"); // now 25 present + 5 leave + 1 absent
  row = await generate(EID);
  check("B1", "5 leaves → exactly 1 LOP day", near(row.lopDays, 1), `lopDays=${row.lopDays}`);
  check("B2", "LOP deduction = 1 × ₹1,000", near(row.lopDeduction, 1000), `deduction=${row.lopDeduction}`);
  check("B3", "Gross = ₹29,000", near(row.grossPay, SALARY - 1000), `gross=${row.grossPay}`);
  acc = await accrualTotal(EID);
  check("B4", PRE_CUTOVER ? "Pre-cutover month still not restated (accrual ₹0)" : "Accrual re-priced to ₹29,000",
    near(acc, PRE_CUTOVER ? 0 : 29000, 0.05), `accrued=${acc}`);

  // ── 4. Scenario C — half-days consume the allowance at 0.5 each ────────
  // 23 present + 2 half-day + 5 leave + 1 absent → worked 24, leave 6,
  // paid leave 4 → payable 28 → LOP 2 → ₹2,000 deducted.
  await setAtt(24, "half_day");
  await setAtt(25, "half_day");
  row = await generate(EID);
  check("C1", "Half-days count as 0.5 leave each → LOP 2", near(row.lopDays, 2), `lopDays=${row.lopDays}`);
  check("C2", "Deduction ₹2,000, gross ₹28,000",
    near(row.lopDeduction, 2000) && near(row.grossPay, 28000),
    `deduction=${row.lopDeduction} gross=${row.grossPay}`);
  check("C3", "Allowance fully used (4/4)", near(row.paidLeaveUsed, ALLOW), `used=${row.paidLeaveUsed}`);
  acc = await accrualTotal(EID);
  check("C4", PRE_CUTOVER ? "Pre-cutover month still not restated (accrual ₹0)" : "Accrual agrees (₹28,000)",
    near(acc, PRE_CUTOVER ? 0 : 28000, 0.05), `accrued=${acc}`);

  // ── 5. LOP disabled → attendance never reduces pay ──────────────────────
  await putGS({ lopEnabled: false });
  row = await generate(EID);
  check("D1", "LOP off → zero LOP and full pay",
    Number(row.lopDays) === 0 && near(row.grossPay, SALARY),
    `lopDays=${row.lopDays} gross=${row.grossPay}`);
  await putGS({ lopEnabled: true });

  // ── 6. Stale policy cannot be approved silently ─────────────────────────
  row = await generate(EID); // back to scenario C figures under live policy
  await putGS({ paidCasualLeavesPerMonth: 2 });
  const stale = await tryApi("POST", `/hr/payroll/${row.id}/approve`, {});
  check("E1", "Approval refused after policy change (regenerate required)",
    !stale.ok && /regenerate/i.test(stale.error), stale.ok ? "approved a stale draft!" : "");
  await putGS({ paidCasualLeavesPerMonth: ALLOW });

  // ── 7. Approve → only the NET salary reaches the books, balanced ───────
  row = await generate(EID);
  await api("POST", `/hr/payroll/${row.id}/approve`, {});
  const [pr] = await q(`SELECT status FROM payroll WHERE id=$1`, [row.id]);
  check("F1", "Payroll approved", pr?.status === "approved", `status=${pr?.status}`);
  // Basic-salary expense = daily accrual + approval true-up on the employee's
  // salary ledger. Employer PF/ESI post to separate statutory expense ledgers,
  // so the SAL-EMP total must equal the post-LOP gross — never the pre-LOP
  // ₹30,000.
  const [snap] = await q(`SELECT gross_pay FROM payroll WHERE id=$1`, [row.id]);
  const expectedExpense = Number(snap?.gross_pay);
  const accNow = await accrualTotal(EID);
  const [vsum] = await q(
    `SELECT COALESCE(SUM(l.debit),0) dr, COALESCE(SUM(l.credit),0) cr
       FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id
      WHERE v.narration LIKE $1`, [`%${emp.name}%`]);
  check("F2", "Approval voucher(s) balanced", near(vsum.dr, vsum.cr), `dr=${vsum.dr} cr=${vsum.cr}`);
  const [expLeg] = await q(
    `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS net
       FROM journal_vouchers v
       JOIN journal_voucher_lines l ON l.voucher_id=v.id
       JOIN account_ledgers al ON al.id=l.ledger_id
      WHERE v.narration LIKE $1 AND al.code = $2`, [`%${emp.name}%`, `SAL-EMP-${EID}`]);
  const totalExpense = Math.round((accNow + Number(expLeg.net)) * 100) / 100;
  check("F3", "Salary expense = post-LOP cost, not pre-LOP ₹30,000",
    near(totalExpense, expectedExpense, 0.05) && totalExpense < SALARY - 0.01,
    `accrued=${accNow} voucherLeg=${expLeg.net} total=${totalExpense} expected=${expectedExpense}`);

  // ── 8. Payslip PDF shows the leave line ─────────────────────────────────
  const pdfResp = await fetch(BASE + "/pdf/payslip", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ payrollId: row.id }),
  });
  let payslipText = "";
  if (pdfResp.ok) {
    const buf = Buffer.from(await pdfResp.arrayBuffer());
    writeFileSync("/tmp/lop-payslip.pdf", buf);
    payslipText = execFileSync("pdftotext", ["/tmp/lop-payslip.pdf", "-"]).toString();
    unlinkSync("/tmp/lop-payslip.pdf");
  }
  check("G1", "Payslip shows Paid Casual Leave and LOP",
    /Paid Casual Leave/i.test(payslipText) && /LOP Days/i.test(payslipText) && /4\s*\/\s*4/.test(payslipText),
    pdfResp.ok ? "" : `pdf ${pdfResp.status}`);

  await cleanup(EID, emp.name);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

/** Voucher deleted whole or not at all — see salary-accrual.test.mjs. */
async function cleanup(empId, empName) {
  await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance WHERE employee_id=$1`, [empId]);
  await q(`UPDATE employee_advances SET deducted_payroll_id=NULL
            WHERE deducted_payroll_id IN (SELECT id FROM payroll WHERE employee_id=$1)`, [empId]).catch(() => {});
  await q(`DELETE FROM payroll WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM pay_components WHERE employee_id=$1`, [empId]);
  const vs = await q(`SELECT id FROM journal_vouchers WHERE narration LIKE $1`, [`%${empName}%`]);
  for (const v of vs) {
    await q(`DELETE FROM journal_voucher_lines WHERE voucher_id=$1`, [v.id]);
    await q(`DELETE FROM journal_vouchers WHERE id=$1`, [v.id]);
  }
  await q(`DELETE FROM account_ledgers WHERE code IN ($1,$2,$3)`,
    [`SAL-EMP-${empId}`, `SAL-PAY-${empId}`, `ADV-EMP-${empId}`]).catch(() => {});
  await q(`DELETE FROM employees WHERE id=$1`, [empId]).catch(() => {});

  // Restore the company settings exactly as found.
  if (savedGS) await api("PATCH", "/company/settings", { generalSettings: savedGS });

  const [bal] = await q(
    `SELECT COALESCE(SUM(l.debit),0) dr, COALESCE(SUM(l.credit),0) cr
       FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id`);
  const gap = Math.round((Number(bal.dr) - Number(bal.cr)) * 100) / 100;
  console.log(gap === 0
    ? "cleanup left the voucher book balanced"
    : `WARNING: cleanup left the voucher book off by ₹${gap}`);
}

main().catch(async (e) => { console.error("\nHARNESS ERROR:", e); try { await sql.end(); } catch {} process.exit(2); });
