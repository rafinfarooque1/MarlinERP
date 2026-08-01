/**
 * Multi-punch attendance — pricing, correction and check-in portal contract.
 *
 * The one figure that matters: a day with punch rows is paid on the TOTAL of
 * its closed sessions, never on the first-in → last-out span (the span counts
 * the breaks between sessions as work). Days without punch rows — everything
 * recorded before punches existed — must keep pricing on the span, identically
 * to what they were always worth.
 *
 * Disposable fixtures only — creates its own employee, cleans up at the end.
 * Punch rows for past dates are seeded via SQL because the check-in API
 * records "now" and cannot backdate; repricing is then triggered through the
 * public correction endpoint, so the pricing path under test is the real one.
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

// ── Direct SQL: seeding backdated punches + verification ───────────────────
import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const Y = 2026, M = 7;
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const IST = (day, hhmm) => `${D(day)}T${hhmm}:00+05:30`;

async function accrualFor(empId, day) {
  const [r] = await q(
    `SELECT amount FROM salary_accruals WHERE employee_id=$1 AND accrual_date=$2`, [empId, D(day)]);
  return r ? Number(r.amount) : null;
}
async function accrualTotal(empId) {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount),0) AS total FROM salary_accruals
      WHERE employee_id=$1 AND year=$2 AND month=$3`, [empId, Y, M]);
  return Number(r.total);
}
async function punchRows(empId, dateStr) {
  return q(
    `SELECT punch_in, punch_out FROM attendance_punches
      WHERE employee_id=$1 AND date=$2 ORDER BY punch_in`, [empId, dateStr]);
}

/** Seed a backdated day: attendance row (span) + its punch sessions. */
async function seedDay(empId, day, sessions /* [['09:00','12:00'], …] */) {
  const first = sessions[0][0], last = sessions[sessions.length - 1][1];
  await q(
    `INSERT INTO attendance (employee_id, date, status, check_in, check_out)
     VALUES ($1,$2,'present',$3,$4)
     ON CONFLICT (employee_id, date) DO UPDATE
       SET status='present', check_in=$3, check_out=$4`,
    [empId, D(day), IST(day, first), IST(day, last)]);
  await q(`DELETE FROM attendance_punches WHERE employee_id=$1 AND date=$2`, [empId, D(day)]);
  for (const [i, o] of sessions) {
    await q(
      `INSERT INTO attendance_punches (employee_id, date, punch_in, punch_out)
       VALUES ($1,$2,$3,$4)`, [empId, D(day), IST(day, i), IST(day, o)]);
  }
}
/** Reprice a seeded day through the public API (status-only keeps punches). */
const reprice = (empId, day) =>
  api("PUT", "/hr/attendance", { employeeId: empId, date: D(day), status: "present" });

async function main() {
  TOKEN = (await api("POST", "/auth/login", { username: "admin", password: "marlin1458" })).token;

  const cfg = await api("GET", "/hr/attendance/config");
  const FULL = Number(cfg.fullDayHours), HALF = Number(cfg.halfDayHours);
  console.log(`thresholds: full ≥ ${FULL}h, half ≥ ${HALF}h  (day starts ${cfg.dayStartTime}, grace ${cfg.lateGraceMinutes}m)\n`);
  const factor = (hrs) => (hrs >= FULL ? 1 : hrs >= HALF ? 0.5 : 0);

  const hiers = await api("GET", "/hr/hierarchies");
  const hierarchyId = hiers[0]?.id;
  const stamp = Date.now();

  // ₹26,000 over the 26-working-day basis = a clean ₹1,000/day.
  const emp = await api("POST", "/hr/employees", {
    name: `PunchTest_${stamp}`, username: `punch_${stamp}`,
    email: `punch${stamp}@test.local`, phone: "9000000003",
    hierarchyId, branchType: "headoffice", branchId: 1,
    salary: 26000, joinDate: D(1),
  });
  const EID = emp.id;
  console.log(`fixture employee #${EID} — ₹26,000/month, joined ${D(1)}\n`);

  // Session times chosen so full-day span vs punched total DISAGREE under the
  // configured thresholds: span = FULL + 0.5h, punched total = HALF + 1h.
  const spanFull = FULL + 0.5;          // old rule says full day
  const punchedTotal = Math.min(HALF + 1, spanFull - 1); // new rule says half day

  // ── A. Correction with explicit times creates exactly one punch pair ─────
  const endA = hm(9 * 60 + spanFull * 60); // 09:00 + span
  await api("PUT", "/hr/attendance",
    { employeeId: EID, date: D(1), status: "present", checkIn: IST(1, "09:00"), checkOut: IST(1, endA) });
  let punches = await punchRows(EID, D(1));
  check("A", "Explicit-times correction leaves exactly one closed punch pair",
    punches.length === 1 && punches[0].punch_out != null,
    `punch rows: ${punches.length}; accrual ₹${await accrualFor(EID, 1)}`);
  check("A2", "Single-session day is priced exactly as the span always was",
    near(await accrualFor(EID, 1), 1000 * factor(spanFull)),
    `₹${await accrualFor(EID, 1)} vs expected ₹${1000 * factor(spanFull)} for ${spanFull}h`);

  // ── B. Legacy day (times, NO punch rows) keeps span pricing ──────────────
  await q(
    `INSERT INTO attendance (employee_id, date, status, check_in, check_out)
     VALUES ($1,$2,'present',$3,$4)`,
    [EID, D(2), IST(2, "09:00"), IST(2, hm(9 * 60 + spanFull * 60))]);
  await reprice(EID, 2);
  const punchesB = await punchRows(EID, D(2));
  check("B", "Pre-punch day (no punch rows) still prices on the span — legacy identical",
    near(await accrualFor(EID, 2), 1000 * factor(spanFull)) && punchesB.length === 0,
    `₹${await accrualFor(EID, 2)} for ${spanFull}h span, ${punchesB.length} punch rows`);

  // ── C. Multi-punch: total hours outvote the span ──────────────────────────
  // Two sessions totalling `punchedTotal` inside a `spanFull` span.
  const s1End = hm(9 * 60 + (punchedTotal - 1) * 60);            // 09:00 → total−1h
  const s2Start = hm(9 * 60 + spanFull * 60 - 60);               // last hour of the span
  const s2End = hm(9 * 60 + spanFull * 60);
  await seedDay(EID, 3, [["09:00", s1End], [s2Start, s2End]]);
  await reprice(EID, 3);
  const expectedC = 1000 * factor(punchedTotal);
  const spanWouldPay = 1000 * factor(spanFull);
  check("C", "Multi-punch day is paid on total punched hours, not first-in → last-out",
    near(await accrualFor(EID, 3), expectedC) && !near(expectedC, spanWouldPay),
    `₹${await accrualFor(EID, 3)} for ${punchedTotal}h punched (span ${spanFull}h would have paid ₹${spanWouldPay})`);

  // ── D. Register derives from punches ──────────────────────────────────────
  const reg = await api("GET", `/hr/attendance?date=${D(3)}`);
  const row3 = (Array.isArray(reg) ? reg : []).find((r) => Number(r.employeeId) === EID);
  const startMin = cfg.dayStartTime.split(":").reduce((h, m) => Number(h) * 60 + Number(m));
  const expLate = Math.max(0, 9 * 60 - (startMin + Number(cfg.lateGraceMinutes)));
  check("D", "Register row exposes punches, punched hours and lateness",
    !!row3 && (row3.punches?.length ?? 0) === 2
      && near(row3.workingHours, punchedTotal, 0.01)
      && Number(row3.lateMinutes) === expLate && row3.openPunchIn == null,
    row3 ? `punches=${row3.punches?.length}, workingHours=${row3.workingHours}, late=${row3.lateMinutes} (exp ${expLate})` : "row missing");

  // ── E. Explicit-times correction REPLACES stale punches ───────────────────
  await api("PUT", "/hr/attendance",
    { employeeId: EID, date: D(3), status: "present", checkIn: IST(3, "09:00"), checkOut: IST(3, hm(9 * 60 + spanFull * 60)) });
  punches = await punchRows(EID, D(3));
  check("E", "Correcting times replaces the day's punches with one matching pair",
    punches.length === 1 && near(await accrualFor(EID, 3), 1000 * factor(spanFull)),
    `punch rows: ${punches.length}; accrual ₹${await accrualFor(EID, 3)} (stale sessions would have paid ₹${expectedC})`);

  // ── F. Clearing times drops the day to its status, punches deleted ────────
  await api("PUT", "/hr/attendance",
    { employeeId: EID, date: D(3), status: "half_day", checkIn: null, checkOut: null });
  punches = await punchRows(EID, D(3));
  check("F", "Clearing times deletes punches and prices the day on status alone",
    punches.length === 0 && near(await accrualFor(EID, 3), 500),
    `punch rows: ${punches.length}; accrual ₹${await accrualFor(EID, 3)} (expected ₹500)`);

  // ── G. Payroll generate agrees with the accrual over a multi-punch month ──
  await seedDay(EID, 6, [["09:00", s1End], [s2Start, s2End]]); // another split day
  await reprice(EID, 6);
  await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: EID });
  const payroll = await api("GET", `/hr/payroll?year=${Y}&month=${M}`);
  const prow = (Array.isArray(payroll) ? payroll : payroll.data ?? []).find((p) => Number(p.employeeId) === EID);
  const earnedBasic = Math.round((Number(prow?.baseSalary ?? 0) - Number(prow?.lopDeduction ?? 0)) * 100) / 100;
  const accrued = await accrualTotal(EID);
  check("G", "Payroll and daily accrual price the multi-punch month identically",
    prow && near(accrued, earnedBasic),
    `accrued ₹${accrued} vs payroll earned basic ₹${earnedBasic} (presentDays=${prow?.presentDays})`);

  // ── H. Locked month still refuses corrections ──────────────────────────────
  await api("POST", `/hr/payroll/${prow.id}/approve`, {});
  const refused = await tryApi("PUT", "/hr/attendance", { employeeId: EID, date: D(10), status: "present" });
  check("H", "Correction in an approved month is refused, not silently ignored",
    !refused.ok && /already paid|already approved/i.test(refused.error),
    refused.ok ? "correction was ACCEPTED in a locked month" : refused.error.slice(0, 140));

  // ── I–L. The check-in portal itself (today, real clock) ───────────────────
  const ci1 = await tryApi("POST", "/hr/attendance/check-in", { employeeId: EID, lat: 12.9716, lng: 77.5946 });
  const ciAgain = await tryApi("POST", "/hr/attendance/check-in", { employeeId: EID, lat: 0, lng: 0 });
  check("I", "Check-in opens a session; a second check-in while open is refused",
    ci1.ok && (ci1.data?.punches?.length ?? 0) >= 1 && !ciAgain.ok && ciAgain.status === 409,
    ci1.ok ? `open sessions visible: ${ci1.data?.punches?.length}; duplicate → ${ciAgain.status}` : ci1.error);

  const co1 = await tryApi("POST", "/hr/attendance/check-out", { employeeId: EID, lat: 12.9716, lng: 77.5946 });
  const coAgain = await tryApi("POST", "/hr/attendance/check-out", { employeeId: EID, lat: 0, lng: 0 });
  check("J", "Check-out closes the session; a second check-out is refused",
    co1.ok && !coAgain.ok && coAgain.status === 409,
    co1.ok ? `duplicate check-out → ${coAgain.status}` : co1.error);

  const ci2 = await tryApi("POST", "/hr/attendance/check-in", { employeeId: EID, lat: 0, lng: 0 });
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const todayPunches = await punchRows(EID, todayStr);
  check("K", "Re-check-in after check-out opens a SECOND session on the same day",
    ci2.ok && todayPunches.length === 2 && todayPunches[1].punch_out == null && todayPunches[0].punch_out != null,
    `sessions today: ${todayPunches.length} (first closed, second open)`);

  const regToday = await api("GET", `/hr/attendance?date=${todayStr}`);
  const myToday = (Array.isArray(regToday) ? regToday : []).find((r) => Number(r.employeeId) === EID);
  check("L", "Open session surfaces as openPunchIn with overtime withheld",
    !!myToday && myToday.openPunchIn != null && myToday.overtimeHours == null,
    myToday ? `openPunchIn=${myToday.openPunchIn}, overtimeHours=${myToday.overtimeHours}` : "row missing");

  // ── M: the mobile "today" contract ─────────────────────────────────────────
  // A handset outside the company timezone that keys "today" on its own
  // calendar asks for the wrong register day around midnight IST and can't see
  // its open session. The contract that prevents this: clients derive today
  // from the config endpoint (its `today`, or `timeZone`), and the register at
  // THAT date always surfaces the open session — regardless of device locale.
  const cfgM = await api("GET", `/hr/attendance/config`);
  const expectedToday = new Date().toLocaleDateString("en-CA", { timeZone: cfgM.timeZone || "Asia/Kolkata" });
  const regCfgDay = await api("GET", `/hr/attendance?date=${cfgM.today}`);
  const myCfgDay = (Array.isArray(regCfgDay) ? regCfgDay : []).find((r) => Number(r.employeeId) === EID);
  check("M", "Config exposes the company operational date and the register at that date holds the open session",
    cfgM.today === expectedToday && !!cfgM.timeZone && !!myCfgDay && myCfgDay.openPunchIn != null,
    `config.today=${cfgM.today} (tz ${cfgM.timeZone}), openPunchIn at that date=${myCfgDay?.openPunchIn ?? "MISSING"}`);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await cleanup(EID, emp.name);
  console.log(`cleaned up fixture employee #${EID}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.id).join(", "));
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

/** minutes-from-midnight → "HH:MM" */
function hm(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Same balanced-books cleanup discipline as the accrual suite. */
async function cleanup(empId, empName) {
  await q(`DELETE FROM attendance_punches WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM attendance WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM payroll WHERE employee_id=$1`, [empId]);
  await q(`DELETE FROM pay_components WHERE employee_id=$1`, [empId]);
  const vs = await q(`SELECT id FROM journal_vouchers WHERE narration LIKE $1`, [`%${empName}%`]);
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
