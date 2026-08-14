/**
 * Payroll auto-calculation, absence classification & employee exit — Task 293.
 *
 * The Generate/Regenerate buttons are gone: GET /hr/payroll (with year+month)
 * refreshes every draft from live attendance before returning, so the list is
 * always current. POST /hr/payroll/generate stays as a compatibility alias and
 * MUST produce bitwise-identical figures (parity to the paisa).
 *
 * Approval refuses months with unclassified absent days (tracked post-cutover
 * month, day <= business today, inside join..LWD, no attendance row, not a
 * holiday/weekly-off) unless the caller explicitly confirms LOP.
 *
 * Approval ALSO refuses any pay period with days that have not occurred yet
 * (409 MONTH_INCOMPLETE, no confirmLop override): generation prices future
 * rowless days as loss of pay only as a projection, and approving mid-month
 * would freeze that projection into the books and permanently underpay the
 * rest of the month. A period is complete when it has ended (month end, or
 * the leaver's last working date) or every remaining day carries a stored
 * attendance/holiday/weekly-off decision.
 *
 * Fixture month = the CURRENT month: the attendance cutover in the dev DB is
 * 2026-08-01, and only post-cutover months classify absences at all.
 */
const BASE = process.env.API_URL || "http://localhost:3101/api";
let TOKEN = "";

const results = [];
function check(id, name, pass, detail = "") {
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;
const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function raw(method, path, body, token = TOKEN) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}
async function api(method, path, body) {
  const r = await raw(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

// ── Direct SQL for verification and cleanup (never for setup) ──────────────
import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const Y = Number(TODAY.slice(0, 4)), M = Number(TODAY.slice(5, 7)), DOM = Number(TODAY.slice(8, 10));
if (DOM < 10) {
  console.log(`SKIP: day-of-month ${DOM} < 10 — the suite needs days 1..5 attended and a few gap days before today.`);
  process.exit(0);
}
const DIM = new Date(Y, M, 0).getDate();
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// Next month (for the future-month approval refusal) — handles Dec→Jan.
const NY = M === 12 ? Y + 1 : Y, NM = M === 12 ? 1 : M + 1;
const DN = (d) => `${NY}-${String(NM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const SALARY = 30000;

let savedGS = null;
async function putGS(patch) {
  const cur = (await api("GET", "/company/settings")).generalSettings ?? {};
  return api("PATCH", "/company/settings", { generalSettings: { ...cur, ...patch } });
}

async function mkEmployee(name, hierarchyId, branch = { branchType: "headoffice", branchId: 1 }) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  return api("POST", "/hr/employees", {
    name: `${name}_${stamp}`, username: `${name.toLowerCase()}_${stamp}`,
    email: `${name.toLowerCase()}${stamp}@test.local`, phone: "9000000007",
    hierarchyId, ...branch,
    salary: SALARY, joinDate: D(1),
  });
}
const setAtt = (empId, day, status, extra = {}) =>
  api("PUT", "/hr/attendance", { employeeId: empId, date: D(day), status, ...extra });

async function listRow(empId) {
  const rows = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
  return (Array.isArray(rows) ? rows : []).find((r) => Number(r.employeeId) === Number(empId));
}
const MONEY_FIELDS = ["baseSalary", "grossPay", "netPay", "lopDays", "lopDeduction",
  "presentDays", "workingDays", "advanceDeduction", "deductions", "allowancesTotal"];

async function main() {
  TOKEN = (await api("POST", "/auth/login", {
    username: process.env.TEST_ADMIN_USER || process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_ADMIN_PASSWORD || process.env.TEST_PASSWORD || "marlin1458",
  })).token;

  savedGS = (await api("GET", "/company/settings")).generalSettings ?? {};
  await putGS({ paidCasualLeavesPerMonth: 4, lopEnabled: true });

  const hiers = await api("GET", "/hr/hierarchies");
  const hierarchyId = hiers[0]?.id;

  const empA = await mkEmployee("AutoCalcA", hierarchyId);
  const empB = await mkEmployee("AutoCalcB", hierarchyId);
  const empC = await mkEmployee("AutoCalcC", hierarchyId);
  console.log(`\nfixture employees #${empA.id} #${empB.id} #${empC.id} — ₹${SALARY}/month over ${DIM} calendar days\n`);

  let empD = null, empV = null, empW = null, empP = null, viewHier = null, opsHier = null;
  try {
    // ── 1. Zero-pay contract: a post-cutover month with NO attendance rows
    // earns nothing and gets no draft row (untracked = zero pay). The list
    // becomes live the moment attendance exists — without any button.
    let rowA = await listRow(empA.id);
    check("A1", "Untracked month stays rowless (zero pay, nothing to show)",
      !rowA, rowA ? `unexpected row status=${rowA.status}` : "");

    // ── 2. Attendance appears → the NEXT READ materialises the draft ───────
    for (let d = 1; d <= 5; d++) await setAtt(empA.id, d, "present");
    rowA = await listRow(empA.id);
    check("A2", "Draft appears and recomputes live once attendance exists (no Generate)",
      !!rowA && rowA.status === "draft" && near(rowA.presentDays, 5),
      rowA ? `status=${rowA.status} presentDays=${rowA.presentDays}` : "row missing");
    check("A3", "Working-days basis = the month's calendar length",
      Number(rowA?.workingDays) === DIM, `workingDays=${rowA?.workingDays} expected ${DIM}`);

    // ── 3. Parity: the compat generate endpoint matches to the paisa ──────
    const gen = await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: empA.id, forceRegenerate: true });
    const genRow = gen.find((r) => Number(r.employeeId) === Number(empA.id));
    const getRow = await listRow(empA.id);
    const diffs = MONEY_FIELDS.filter((f) => r2(genRow?.[f] ?? 0) !== r2(getRow?.[f] ?? 0));
    check("A4", "POST generate and the live GET agree on every figure (to the paisa)",
      diffs.length === 0, diffs.map((f) => `${f}: gen=${genRow?.[f]} get=${getRow?.[f]}`).join("; "));

    // ── 4. A deleted draft resurrects on the next read ─────────────────────
    await q(`DELETE FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3 AND status='draft'`, [empA.id, Y, M]);
    rowA = await listRow(empA.id);
    check("A5", "Draft is recreated idempotently on read after deletion",
      !!rowA && rowA.status === "draft" && near(rowA.presentDays, 5),
      rowA ? `presentDays=${rowA.presentDays}` : "row missing");

    // ── 5. Unclassified absences: gap days 6..today, minus offs/holidays ───
    const gapSet = new Set();
    for (let d = 6; d <= DOM; d++) gapSet.add(D(d));
    const uncl = await api("GET", `/hr/payroll/unclassified-absences?year=${Y}&month=${M}&employeeId=${empA.id}`);
    const mine = uncl.find((u) => Number(u.employeeId) === Number(empA.id));
    const dates = mine?.dates ?? [];
    check("U1", "Endpoint lists the uncovered past days (subset of the real gaps, non-empty)",
      dates.length > 0 && dates.every((dt) => gapSet.has(dt)),
      `dates=${dates.join(",")}`);

    // ── 6. Mid-month approval is refused OUTRIGHT: the period is incomplete ─
    // Future rowless days would be frozen in as loss of pay, so the refusal
    // comes before (and regardless of) classification, and confirmLop is NOT
    // an override — it is a statement about days that occurred.
    if (DOM < DIM) {
      const apprEarly = await raw("POST", `/hr/payroll/${rowA.id}/approve`, {});
      const futDates = apprEarly.data?.monthIncomplete ?? [];
      check("U2", "Mid-month approve → 409 MONTH_INCOMPLETE listing only future days",
        apprEarly.status === 409 && apprEarly.data?.code === "MONTH_INCOMPLETE"
          && futDates.length > 0 && futDates.every((dt) => dt > TODAY),
        `status=${apprEarly.status} code=${apprEarly.data?.code} dates=${JSON.stringify(futDates)}`);
      const apprForced = await raw("POST", `/hr/payroll/${rowA.id}/approve`, { confirmLop: true });
      check("U2b", "confirmLop does NOT override an incomplete period",
        apprForced.status === 409 && apprForced.data?.code === "MONTH_INCOMPLETE",
        `status=${apprForced.status} code=${apprForced.data?.code}`);
    } else {
      check("U2", "Mid-month refusal (skipped — today is the last day of the month)", true);
      check("U2b", "confirmLop override refusal (skipped — today is the last day of the month)", true);
    }

    // ── 7. Classify through the attendance-correction machinery ───────────
    // Round-robin over the four classifications the UI offers.
    const kinds = [
      { status: "leave", leaveType: "casual" },
      { status: "leave", leaveType: "sick" },
      { status: "weekly_off" }, // "Paid Off" — no weekly-off rule on a gap day, so no CL gate
      { status: "absent" },     // explicit LOP
    ];
    for (let i = 0; i < dates.length; i++) {
      const day = Number(dates[i].slice(8, 10));
      const k = kinds[i % kinds.length];
      await setAtt(empA.id, day, k.status, k.leaveType ? { leaveType: k.leaveType } : {});
    }
    const uncl2 = await api("GET", `/hr/payroll/unclassified-absences?year=${Y}&month=${M}&employeeId=${empA.id}`);
    const mine2 = uncl2.find((u) => Number(u.employeeId) === Number(empA.id));
    check("U3", "Classifying every day empties the unclassified list",
      !mine2, mine2 ? `still: ${mine2.dates.join(",")}` : "");

    // ── 8. Classification alone must NOT unlock a mid-month approval ──────
    // This is exactly the regression the gate exists for: every past day is
    // now classified, yet the rest of the month is still a projection.
    if (DOM < DIM) {
      rowA = await listRow(empA.id);
      const apprMid = await raw("POST", `/hr/payroll/${rowA.id}/approve`, {});
      check("U3b", "Fully-classified past days still refuse a mid-month approval",
        apprMid.status === 409 && apprMid.data?.code === "MONTH_INCOMPLETE",
        `status=${apprMid.status} code=${apprMid.data?.code}`);
    } else {
      check("U3b", "Mid-month refusal after classification (skipped — last day of month)", true);
    }

    // ── 9. Complete the period with stored decisions → approval goes through ─
    // Rostering the rest of the month as present is a stored decision for
    // every remaining day, which is what "complete" means for an active
    // employee before month end.
    for (let d = DOM + 1; d <= DIM; d++) await setAtt(empA.id, d, "present");
    rowA = await listRow(empA.id); // refresh after the corrections
    const appr2 = await raw("POST", `/hr/payroll/${rowA.id}/approve`, {});
    check("U4", "Approval succeeds once every day of the period carries a decision",
      appr2.status < 400 && appr2.data?.status === "approved",
      `status=${appr2.status} payroll=${appr2.data?.status ?? JSON.stringify(appr2.data).slice(0, 120)}`);
    const [vsum] = await q(
      `SELECT COALESCE(SUM(l.debit),0) dr, COALESCE(SUM(l.credit),0) cr
         FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id
        WHERE v.narration LIKE $1`, [`%${empA.name}%`]);
    check("B1", "Approval voucher(s) balanced", near(vsum.dr, vsum.cr), `dr=${vsum.dr} cr=${vsum.cr}`);
    const accA = await q(
      `SELECT COALESCE(SUM(amount),0) AS t FROM salary_accruals WHERE employee_id=$1 AND year=$2 AND month=$3`,
      [empA.id, Y, M]);
    const [expLeg] = await q(
      `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS net
         FROM journal_vouchers v
         JOIN journal_voucher_lines l ON l.voucher_id=v.id
         JOIN account_ledgers al ON al.id=l.ledger_id
        WHERE v.narration LIKE $1 AND al.code = $2`, [`%${empA.name}%`, `SAL-EMP-${empA.id}`]);
    const totalExpense = r2(Number(accA[0].t) + Number(expLeg.net));
    check("B2", "Salary expense (accrual + true-up) = the approved gross",
      near(totalExpense, Number(rowA.grossPay), 0.05),
      `accrued=${accA[0].t} trueUp=${expLeg.net} total=${totalExpense} gross=${rowA.grossPay}`);

    // ── 10. Explicit-LOP override approves despite unclassified PAST days ──
    // Future days are rostered present so only the past gaps block — the
    // classification gate (UNCLASSIFIED_ABSENCES) must carry the endpoint's
    // dates and yield to confirmLop.
    for (let d = 1; d <= 3; d++) await setAtt(empB.id, d, "present");
    for (let d = DOM + 1; d <= DIM; d++) await setAtt(empB.id, d, "present");
    const unclB = await api("GET", `/hr/payroll/unclassified-absences?year=${Y}&month=${M}&employeeId=${empB.id}`);
    const datesB = unclB.find((u) => Number(u.employeeId) === Number(empB.id))?.dates ?? [];
    const rowB = await listRow(empB.id);
    const apprB1 = await raw("POST", `/hr/payroll/${rowB.id}/approve`, {});
    const apprB2 = apprB1.status === 409 && apprB1.data?.code === "UNCLASSIFIED_ABSENCES"
      ? await raw("POST", `/hr/payroll/${rowB.id}/approve`, { confirmLop: true })
      : apprB1;
    check("C1", "confirmLop approves over unclassified past days (blocked without it)",
      apprB1.status === 409 && apprB1.data?.code === "UNCLASSIFIED_ABSENCES"
        && JSON.stringify(apprB1.data?.unclassifiedAbsences ?? []) === JSON.stringify(datesB)
        && apprB2.status < 400 && apprB2.data?.status === "approved",
      `first=${apprB1.status}/${apprB1.data?.code} second=${apprB2.status} dates=${JSON.stringify(apprB1.data?.unclassifiedAbsences)}`);
    check("C2", "Unclassified days priced as LOP in the approved figures",
      Number(rowB.lopDays) > 0 && Number(rowB.grossPay) < SALARY,
      `lopDays=${rowB.lopDays} gross=${rowB.grossPay}`);

    // ── 11. An entirely FUTURE month can never be approved ────────────────
    // Rows entered ahead (a roster) materialise a draft, but every remaining
    // rowless day is in the future — refused with or without confirmLop.
    await api("PUT", "/hr/attendance", { employeeId: empB.id, date: DN(1), status: "present" });
    await api("PUT", "/hr/attendance", { employeeId: empB.id, date: DN(2), status: "present" });
    const rowsN = await api("GET", `/hr/payroll?year=${NY}&month=${NM}`);
    const rowBN = (Array.isArray(rowsN) ? rowsN : []).find((r) => Number(r.employeeId) === Number(empB.id));
    const apprN1 = rowBN ? await raw("POST", `/hr/payroll/${rowBN.id}/approve`, {}) : null;
    const apprN2 = rowBN ? await raw("POST", `/hr/payroll/${rowBN.id}/approve`, { confirmLop: true }) : null;
    check("F1", "Future month draft exists but approval is refused, even with confirmLop",
      !!rowBN && apprN1.status === 409 && apprN1.data?.code === "MONTH_INCOMPLETE"
        && apprN2.status === 409 && apprN2.data?.code === "MONTH_INCOMPLETE",
      rowBN ? `plain=${apprN1.status}/${apprN1.data?.code} forced=${apprN2.status}/${apprN2.data?.code}` : "no draft for the future month");

    // ── 12. A view-only principal must never write by reading ─────────────
    // The live refresh creates/updates/tears down drafts and (re)claims
    // advances — it may only run for callers holding the same `add` right as
    // POST /hr/payroll/generate. A view-only user listing a month must leave
    // the payroll table (and therefore advance claims, which only the refresh
    // touches on the read path) bitwise untouched.
    const rootH = hiers.find((h) => Number(h.level) === 1) ?? hiers[0];
    viewHier = await api("POST", "/hr/hierarchies", {
      name: `ViewOnly293_${Date.now()}`, reportsToId: rootH.id, description: "payroll view-only (test)",
    });
    await api("POST", "/company/permissions", {
      hierarchyId: viewHier.id, module: "page:/hr/payroll",
      canView: true, canAdd: false, canEdit: false, canDelete: false, canDownload: false,
    });
    empV = await mkEmployee("AutoCalcV", viewHier.id);
    const resetV = await api("POST", `/hr/employees/${empV.id}/reset-password`, {});
    const tokenV = (await api("POST", "/auth/login", { username: empV.username, password: resetV.password })).token;

    empD = await mkEmployee("AutoCalcD", hierarchyId);
    for (let d = 1; d <= 2; d++) await setAtt(empD.id, d, "present");
    const rowD1 = await listRow(empD.id); // admin read materialises the draft
    await q(`DELETE FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3 AND status='draft'`, [empD.id, Y, M]);
    const viewRes = await raw("GET", `/hr/payroll?year=${Y}&month=${M}`, undefined, tokenV);
    const [{ n: nAfterView }] = await q(
      `SELECT COUNT(*)::int AS n FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3`, [empD.id, Y, M]);
    check("V1", "View-only GET returns 200 but does NOT resurrect the deleted draft (no write ran)",
      !!rowD1 && viewRes.status === 200 && nAfterView === 0,
      `admin draft=${!!rowD1} viewStatus=${viewRes.status} rowsAfterViewOnlyRead=${nAfterView}`);
    const rowD2 = await listRow(empD.id); // the write-capable read refreshes again
    check("V2", "The same read WITH the add right resurrects the draft (gate keys on the right)",
      !!rowD2 && rowD2.status === "draft" && near(rowD2.presentDays, 2),
      rowD2 ? `presentDays=${rowD2.presentDays}` : "row missing");

    // A self-scoped BRANCH employee who happens to hold the payroll `add`
    // right must STILL read read-only: the refresh is for head-office
    // operators running the month, never for someone viewing their own
    // payslip. Advance claims live inside the refresh, so proving the draft
    // stays deleted (and the advances table fingerprint is bitwise
    // unchanged) proves period navigation cannot shift an advance claim.
    const [wh] = await q(
      `SELECT id FROM warehouses WHERE COALESCE(disabled_at::text,'') = '' ORDER BY id LIMIT 1`,
    ).catch(() => q(`SELECT id FROM warehouses ORDER BY id LIMIT 1`));
    opsHier = await api("POST", "/hr/hierarchies", {
      name: `BranchOps293_${Date.now()}`, reportsToId: rootH.id, description: "branch payroll add (test)",
    });
    await api("POST", "/company/permissions", {
      hierarchyId: opsHier.id, module: "page:/hr/payroll",
      canView: true, canAdd: true, canEdit: false, canDelete: false, canDownload: false,
    });
    empW = await mkEmployee("AutoCalcW", opsHier.id, { branchType: "warehouse", branchId: wh.id });
    const resetW = await api("POST", `/hr/employees/${empW.id}/reset-password`, {});
    const tokenW = (await api("POST", "/auth/login", { username: empW.username, password: resetW.password })).token;
    for (let d = 1; d <= 2; d++) await setAtt(empW.id, d, "present");
    await listRow(empW.id); // operator read materialises the branch draft
    await q(`DELETE FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3 AND status='draft'`, [empW.id, Y, M]);
    const advBefore = JSON.stringify(await q(
      `SELECT id, employee_id, deducted_payroll_id, is_deducted FROM employee_advances ORDER BY id`));
    const selfRes = await raw("GET", `/hr/payroll?year=${Y}&month=${M}`, undefined, tokenW);
    const [{ n: nAfterSelf }] = await q(
      `SELECT COUNT(*)::int AS n FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3`, [empW.id, Y, M]);
    const advAfter = JSON.stringify(await q(
      `SELECT id, employee_id, deducted_payroll_id, is_deducted FROM employee_advances ORDER BY id`));
    check("V3", "Self-scoped branch reader WITH add: own read is still read-only (no draft, no advance shift)",
      selfRes.status === 200 && nAfterSelf === 0 && advBefore === advAfter,
      `selfStatus=${selfRes.status} rowsAfterSelfRead=${nAfterSelf} advancesUnchanged=${advBefore === advAfter}`);
    const rowW2 = await listRow(empW.id); // operator read brings the draft back
    check("V4", "Operator (head-office) read refreshes the branch draft back into existence",
      !!rowW2 && rowW2.status === "draft" && near(rowW2.presentDays, 2),
      rowW2 ? `presentDays=${rowW2.presentDays}` : "row missing");

    // ── 13. Concurrent operator reads materialise exactly ONE draft ───────
    // Two operators loading a not-yet-materialised month at the same moment
    // must not each insert a draft: the month-level refresh lock serialises
    // them, and the unique index on (employee_id, year, month) is the
    // database's own backstop. Advance claims are written inside the same
    // serialised refresh, so the advances fingerprint must come out stable.
    await q(`DELETE FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3 AND status='draft'`, [empD.id, Y, M]);
    const advP0 = JSON.stringify(await q(
      `SELECT id, employee_id, deducted_payroll_id, is_deducted FROM employee_advances ORDER BY id`));
    const bursts = await Promise.all(Array.from({ length: 6 }, () =>
      raw("GET", `/hr/payroll?year=${Y}&month=${M}`)));
    const dupRows = await q(
      `SELECT employee_id, COUNT(*)::int AS n FROM payroll WHERE year=$1 AND month=$2 GROUP BY employee_id HAVING COUNT(*) > 1`, [Y, M]);
    const [{ n: nD }] = await q(
      `SELECT COUNT(*)::int AS n FROM payroll WHERE employee_id=$1 AND year=$2 AND month=$3`, [empD.id, Y, M]);
    const advP1 = JSON.stringify(await q(
      `SELECT id, employee_id, deducted_payroll_id, is_deducted FROM employee_advances ORDER BY id`));
    check("P1", "Six concurrent month views leave one draft per employee and stable advance claims",
      bursts.every((r) => r.status === 200) && dupRows.length === 0 && nD === 1 && advP0 === advP1,
      `statuses=${bursts.map((r) => r.status).join(",")} dupEmployees=${dupRows.length} empDrows=${nD} advancesStable=${advP0 === advP1}`);
    const dupTry = await q(
      `INSERT INTO payroll (employee_id, month, year) VALUES ($1,$2,$3) RETURNING id`, [empD.id, M, Y],
    ).then((r) => { return q(`DELETE FROM payroll WHERE id=$1`, [r[0].id]).then(() => "inserted"); })
     .catch((e) => e.code ?? String(e.message));
    check("P2", "The database itself refuses a duplicate employee-month payroll row (unique index)",
      dupTry === "23505", `duplicate insert result=${dupTry}`);

    // A refresh racing an APPROVAL must never resurrect the draft: the
    // refresh's pre-transaction read races approval's row lock, so a refresh
    // queued behind an in-flight approval resumes after its commit — and must
    // then pass the approved row through untouched, not reset a posted
    // document back to draft. Deterministic interleaving: a test transaction
    // holds the payroll row lock FOR UPDATE, the approval is fired first
    // (queues on the lock), the refresh second (queues behind approval), then
    // the lock is released — Postgres grants conflicting locks in FIFO order.
    for (let d = 3; d <= DIM; d++) await setAtt(empD.id, d, "present");
    const rowD3 = await listRow(empD.id); // refresh the draft to full-month figures first (drift gate)
    const lockCx = await sql.connect();
    let aRes, rRes;
    try {
      await lockCx.query("BEGIN");
      await lockCx.query(`SELECT id FROM payroll WHERE id = $1 FOR UPDATE`, [rowD3.id]);
      const approvalP = raw("POST", `/hr/payroll/${rowD3.id}/approve`, {});
      await new Promise((r) => setTimeout(r, 400)); // approval reaches the row lock first
      const refreshP = raw("GET", `/hr/payroll?year=${Y}&month=${M}`);
      await new Promise((r) => setTimeout(r, 400)); // refresh queues behind it
      await lockCx.query("COMMIT");
      [aRes, rRes] = await Promise.all([approvalP, refreshP]);
    } finally {
      lockCx.release();
    }
    const [rowFinal] = await q(
      `SELECT status, net_pay FROM payroll WHERE id = $1`, [rowD3.id]);
    const [{ n: vFinal }] = await q(
      `SELECT COUNT(DISTINCT jv.id)::int AS n FROM journal_vouchers jv WHERE jv.narration LIKE $1`,
      [`%${empD.name}%`]);
    const servedRow = Array.isArray(rRes.data) ? rRes.data.find((p) => Number(p.employeeId ?? p.employee_id) === empD.id) : null;
    check("P3", "A refresh queued behind an approval passes the approved row through untouched",
      aRes.status === 200 && rRes.status === 200
        && rowFinal.status === "approved" && vFinal === 1
        && servedRow && servedRow.status === "approved",
      `approve=${aRes.status} refresh=${rRes.status} finalStatus=${rowFinal.status} vouchers=${vFinal} servedStatus=${servedRow?.status}`);

    // The REVERSE interleaving: approval's route-level pre-read happens
    // before a refresh commits changed figures — here a freshly claimed
    // advance. Deterministic ordering via the same held-lock trick: the
    // refresh is fired first (queues on the row lock and will claim the
    // advance), the approval second (its unlocked pre-read sees the OLD
    // draft, then queues behind the refresh). After release the refresh
    // commits the new deduction, and approval — which re-reads the whole row
    // under its own lock — must post net-of-advance and settle the advance,
    // not replay its stale pre-read (which would leave the claimed advance
    // unsettled while approving the refreshed row).
    empP = await mkEmployee("AutoCalcP", hierarchyId);
    for (let d = 1; d <= DIM; d++) await setAtt(empP.id, d, "present");
    const rowP0 = await listRow(empP.id); // draft, advance_deduction = 0
    const advP = await raw("POST", "/hr/advances", { employeeId: empP.id, amount: 2000, date: D(2), note: "race advance" });
    const lockCx2 = await sql.connect();
    let apprPq, refrPq;
    try {
      await lockCx2.query("BEGIN");
      await lockCx2.query(`SELECT id FROM payroll WHERE id = $1 FOR UPDATE`, [rowP0.id]);
      refrPq = raw("GET", `/hr/payroll?year=${Y}&month=${M}`);
      await new Promise((r) => setTimeout(r, 400));
      apprPq = raw("POST", `/hr/payroll/${rowP0.id}/approve`, {});
      await new Promise((r) => setTimeout(r, 400));
      await lockCx2.query("COMMIT");
    } finally {
      lockCx2.release();
    }
    const [aP, rP] = await Promise.all([apprPq, refrPq]);
    const [rowPf] = await q(`SELECT status, advance_deduction, net_pay FROM payroll WHERE id = $1`, [rowP0.id]);
    const [advPf] = await q(`SELECT is_deducted, deducted_payroll_id FROM employee_advances WHERE id = $1`, [advP.data?.id]);
    const [{ n: vPn }] = await q(
      `SELECT COUNT(DISTINCT id)::int AS n FROM journal_vouchers WHERE narration LIKE $1 AND narration LIKE '%Salary Approved%'`,
      [`%${empP.name}%`]);
    check("P4", "An approval overtaken by a refresh posts the refreshed figures and settles the claimed advance",
      aP.status === 200 && rP.status === 200
        && rowPf.status === "approved"
        && near(rowPf.advance_deduction, 2000)
        && near(aP.data?.netPay, Number(rowPf.net_pay))
        && advPf?.is_deducted === true && Number(advPf?.deducted_payroll_id) === Number(rowP0.id)
        && vPn === 1,
      `approve=${aP.status} refresh=${rP.status} status=${rowPf.status} advDeduction=${rowPf.advance_deduction} `
      + `respNet=${aP.data?.netPay} rowNet=${rowPf.net_pay} advSettled=${advPf?.is_deducted} vouchers=${vPn}`);

    // ── 10. Employee exit: LWD bounds the month; reason round-trips ────────
    for (let d = 1; d <= 5; d++) await setAtt(empC.id, d, "present");
    await api("PATCH", `/hr/employees/${empC.id}`, {
      employmentStatus: "resigned", lastWorkingDate: D(8), leavingReason: "  family relocation  ",
    });
    const detC = await api("GET", `/hr/employees/${empC.id}`);
    check("R1", "Resignation stores status, LWD and the trimmed reason",
      detC.employmentStatus === "resigned" && detC.lastWorkingDate === D(8)
        && detC.leavingReason === "family relocation",
      `status=${detC.employmentStatus} lwd=${detC.lastWorkingDate} reason=${JSON.stringify(detC.leavingReason)}`);

    const unclC = await api("GET", `/hr/payroll/unclassified-absences?year=${Y}&month=${M}&employeeId=${empC.id}`);
    const mineC = unclC.find((u) => Number(u.employeeId) === Number(empC.id));
    const beyondLwd = (mineC?.dates ?? []).filter((dt) => dt > D(8));
    check("R2", "Unclassified days never extend past the last working date",
      beyondLwd.length === 0, beyondLwd.join(","));

    const rowC = await listRow(empC.id);
    check("R3", "Leaver still gets a payroll row for the exit month (bounded)",
      !!rowC && near(rowC.presentDays, 5), rowC ? `presentDays=${rowC.presentDays}` : "row missing");

    // The leaver's payable period ENDS at the LWD, so — unlike everyone
    // else's — the month is approvable mid-month once the past gaps (6..8)
    // are confirmed as LOP.
    const apprC = await raw("POST", `/hr/payroll/${rowC.id}/approve`, { confirmLop: true });
    check("R3b", "Leaver's exit month approves mid-month (period complete at LWD)",
      apprC.status < 400 && apprC.data?.status === "approved",
      `status=${apprC.status} body=${JSON.stringify(apprC.data).slice(0, 120)}`);

    await api("PATCH", `/hr/employees/${empC.id}`, { employmentStatus: "active" });
    const detC2 = await api("GET", `/hr/employees/${empC.id}`);
    check("R4", "Reactivation clears LWD and the leaving reason (effective-value rule)",
      detC2.employmentStatus === "active" && detC2.lastWorkingDate == null && detC2.leavingReason == null,
      `status=${detC2.employmentStatus} lwd=${detC2.lastWorkingDate} reason=${JSON.stringify(detC2.leavingReason)}`);
  } finally {
    for (const e of [empA, empB, empC, empD, empV, empW, empP].filter(Boolean))
      await cleanup(e.id, e.name).catch((err) => console.log(`cleanup #${e.id}: ${err.message}`));
    for (const h of [viewHier, opsHier].filter(Boolean)) {
      await q(`DELETE FROM permissions WHERE hierarchy_id=$1`, [h.id]).catch(() => {});
      await q(`DELETE FROM hierarchies WHERE id=$1`, [h.id]).catch(() => {});
    }
    if (savedGS) await api("PATCH", "/company/settings", { generalSettings: savedGS }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.id).join(", "));
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

/** Same teardown discipline as lop-payroll: vouchers whole or not at all. */
async function cleanup(empId, empName) {
  await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance_punches WHERE employee_id=$1`, [empId]).catch(() => {});
  await q(`UPDATE employee_advances SET deducted_payroll_id=NULL
            WHERE deducted_payroll_id IN (SELECT id FROM payroll WHERE employee_id=$1)`, [empId]).catch(() => {});
  // Advances created by this suite (and their disbursement payment vouchers).
  const advRows = await q(`SELECT payment_voucher_id FROM employee_advances WHERE employee_id=$1`, [empId]).catch(() => []);
  for (const a of advRows) if (a.payment_voucher_id)
    await q(`DELETE FROM payments WHERE id=$1`, [a.payment_voucher_id]).catch(() => {});
  await q(`DELETE FROM employee_advances WHERE employee_id=$1`, [empId]).catch(() => {});
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
}

main().catch(async (e) => { console.error("\nHARNESS ERROR:", e); try { await sql.end(); } catch {} process.exit(2); });
