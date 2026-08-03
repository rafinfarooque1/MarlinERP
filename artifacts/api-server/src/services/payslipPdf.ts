/**
 * Payslip PDF generator — A4 portrait, one page for a normal salary run.
 *
 * The route assembles this input from the stored payroll row, so the slip always
 * reflects the figures the run was approved on — never a recomputation against
 * today's statutory rates. Nothing in this file does arithmetic on the payroll
 * beyond adding up the rows it prints.
 *
 * Layout notes, because the previous version got these wrong:
 *   • Earnings and deductions sit side by side in two balanced columns rather
 *     than in one long stack, which is what a salary slip is expected to look
 *     like and what keeps it on a single page.
 *   • The signature area follows the summary immediately. It used to be pinned
 *     to a fixed offset from the bottom of the page, which left a large empty
 *     band in the middle of every slip.
 *   • Money is printed with the real rupee sign, which needs the embedded
 *     Unicode face from the shared kit.
 *
 * The two columns reconcile: (Gross Earnings) - (Total Deductions) = Net Pay,
 * because gross_pay is stored net of LOP and net_pay is stored net of both the
 * configured deductions and any advance recovery.
 */
import { jsPDF } from "jspdf";
import {
  registerFonts, Painter, stampFooters, amountInWords, inr, dateIN,
  NAVY, TEAL, WHITE, LGRAY, MGRAY, BORDER, GREEN, RED, AMBER,
  PW, PH, M, CW,
} from "@workspace/pdf-kit";

export interface PayslipBreakdownItem { name: string; amount: number }

export interface PayslipPdfInput {
  cs?: {
    companyName?: string;
    address?: string; city?: string; state?: string; pincode?: string;
    gstNumber?: string; phone?: string; email?: string;
    /** Only rendered when it is an inline data URL; see the route. */
    logoDataUrl?: string;
  };
  employeeName: string;
  branchName: string;
  monthLabel: string;
  workingDays: number;
  presentDays: number;
  lopDays: number;
  lopDeduction: number;
  // ── Leave policy (Aug 2026) ──────────────────────────────────────────────
  // Null/undefined on payroll rows generated before the LOP change: the
  // payslip must then keep its original four attendance tiles rather than
  // invent a "0 leave" figure the run never computed.
  paidLeaveUsed?: number | null;
  paidLeaveAllowed?: number | null;
  baseSalary: number;
  allowancesBreakdown: PayslipBreakdownItem[];
  deductionsBreakdown: PayslipBreakdownItem[];
  grossPay: number;
  deductions: number;
  netPay: number;
  isPaid: boolean;
  paidDate?: string | null;
  // ── Statutory / audit additions ──────────────────────────────────────────
  employeeCode?: string;
  designation?: string;
  joinDate?: string | null;
  advanceDeduction?: number;
  extraAmount?: number;
  extraNote?: string | null;
  pfEmployer?: number;
  esiEmployer?: number;
  status?: string;
  paidAmount?: number;
}

const DASH = "-";
/** Day counts print whole when whole, one decimal otherwise (4.5, not 4.50). */
const fmtDays = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};
const has = (n: unknown) => Math.abs(Number(n) || 0) > 0.004;
const val = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? DASH : s;
};

export async function generatePayslipPdf(data: PayslipPdfInput): Promise<Buffer> {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  await registerFonts(doc);
  const p = new Painter(doc);

  const cName = data.cs?.companyName || "Company";
  const isPaid = !!data.isPaid;
  const extraAmt = Number(data.extraAmount ?? 0);
  const advance = Number(data.advanceDeduction ?? 0);
  const grossEarnings = Number(data.grossPay ?? 0) + extraAmt;
  const totalDeductions = Number(data.deductions ?? 0) + advance;
  const netTotal = Number(data.netPay ?? 0);

  let y = M;

  // ── Header band ───────────────────────────────────────────────────────────
  const bandH = 20;
  p.fill(M, y, CW, bandH, NAVY);

  let tx = M + 4;
  const logo = data.cs?.logoDataUrl;
  if (logo && logo.startsWith("data:image/")) {
    try {
      const fmt = logo.startsWith("data:image/png") ? "PNG"
        : logo.startsWith("data:image/webp") ? "WEBP" : "JPEG";
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(M + 3, y + 3, 15, 14, 1.2, 1.2, "F");
      doc.addImage(logo, fmt, M + 4.5, y + 4.2, 12, 11.6, undefined, "FAST");
      tx = M + 21;
    } catch { /* fall through to the wordmark alone */ }
  }

  p.txt(cName, tx, y + 8.5, { size: 12.5, bold: true, color: WHITE });
  const addr = [data.cs?.address, [data.cs?.city, data.cs?.state, data.cs?.pincode]
    .filter(Boolean).join(", ")].filter(Boolean).join(" \u2022 ");
  if (addr) {
    p.txt(p.wrap(addr, CW / 2, 6.2)[0] ?? "", tx, y + 13.5, { size: 6.2, color: [180, 200, 225] });
  }

  p.txt("PAYSLIP", PW - M - 4, y + 8, { size: 13, bold: true, color: WHITE, align: "right" });
  p.txt(val(data.monthLabel), PW - M - 4, y + 13.5,
    { size: 7.6, color: [180, 200, 225], align: "right" });
  y += bandH;

  // Status strip, under the band so the band itself stays clean.
  const statusH = 7;
  p.fill(M, y, CW, statusH, isPaid ? [232, 248, 238] : [255, 247, 227]);
  p.box(M, y, CW, statusH, BORDER, 0.2);
  p.txt(isPaid ? "STATUS: PAID" : "STATUS: PENDING", M + 3, y + 4.9,
    { size: 7, bold: true, color: isPaid ? GREEN : AMBER });
  if (isPaid && data.paidDate) {
    p.txt(`Paid on ${dateIN(data.paidDate)}`, PW - M - 3, y + 4.9,
      { size: 6.8, color: [70, 80, 95], align: "right" });
  } else if (has(data.paidAmount)) {
    p.txt(
      `Part payment ${inr(Number(data.paidAmount))} \u2022 Balance ${inr(netTotal - Number(data.paidAmount))}`,
      PW - M - 3, y + 4.9, { size: 6.8, color: AMBER, align: "right" },
    );
  }
  y += statusH + 3.5;

  // ── Employee details, two columns ─────────────────────────────────────────
  const empH = 21;
  const halfW = CW / 2;
  p.box(M, y, CW, empH, BORDER, 0.25);
  p.line(M + halfW, y + 1.5, M + halfW, y + empH - 1.5, BORDER, 0.2);

  const pair = (x: number, rows: Array<[string, string]>) => {
    let ly = y + 5;
    for (const [label, value] of rows) {
      p.txt(label, x, ly, { size: 6, color: MGRAY });
      p.txt(value, x + 26, ly, { size: 7.6, bold: true });
      ly += 5.2;
    }
  };
  pair(M + 3, [
    ["EMPLOYEE", val(data.employeeName)],
    ["EMPLOYEE ID", val(data.employeeCode)],
    ["DESIGNATION", val(data.designation)],
  ]);
  pair(M + halfW + 3, [
    ["LOCATION", val(data.branchName)],
    ["DATE OF JOINING", dateIN(data.joinDate)],
    ["PAY PERIOD", val(data.monthLabel)],
  ]);
  y += empH + 3.5;

  // ── Attendance ────────────────────────────────────────────────────────────
  // Paid days is working days less loss-of-pay days, which is the definition
  // the payroll run itself uses when it prices a day of LOP.
  const lopDays = Number(data.lopDays ?? 0);
  const workingDays = Number(data.workingDays ?? 0);
  const attH = 13;
  p.fill(M, y, CW, 5.2, TEAL);
  p.txt("ATTENDANCE SUMMARY", M + 3, y + 3.7, { size: 6, bold: true, color: WHITE });
  p.box(M, y, CW, attH, BORDER, 0.25);
  // Rows generated since the leave policy exists carry the paid-casual-leave
  // snapshot; stored present days are the days PAID for (worked + paid leave),
  // so the worked figure shown is present minus the leave credited. Older rows
  // have no snapshot and keep the original four tiles — absent is not zero.
  const hasLeavePolicy = data.paidLeaveAllowed != null;
  const paidLeaveUsed = Number(data.paidLeaveUsed ?? 0);
  const att: Array<[string, string]> = hasLeavePolicy
    ? [
        ["Working Days", String(workingDays)],
        ["Present Days", fmtDays(Number(data.presentDays ?? 0) - paidLeaveUsed)],
        ["Paid Casual Leave", `${fmtDays(paidLeaveUsed)} / ${fmtDays(Number(data.paidLeaveAllowed))}`],
        ["LOP Days", fmtDays(lopDays)],
        ["Paid Days", fmtDays(Math.max(0, workingDays - lopDays))],
      ]
    : [
        ["Working Days", String(workingDays)],
        ["Present Days", String(Number(data.presentDays ?? 0))],
        ["Absent / LOP Days", String(lopDays)],
        ["Paid Days", String(Math.max(0, Math.round((workingDays - lopDays) * 100) / 100))],
      ];
  const attW = CW / att.length;
  att.forEach(([label, value], i) => {
    const cx = M + attW * i;
    if (i > 0) p.line(cx, y + 5.2, cx, y + attH, BORDER, 0.2);
    p.txt(label, cx + attW / 2, y + 9, { size: 5.8, color: MGRAY, align: "center" });
    p.txt(value, cx + attW / 2, y + 12.2, { size: 8.2, bold: true, align: "center" });
  });
  y += attH + 3.5;

  // ── Earnings / Deductions, side by side and balanced ──────────────────────
  const colW = (CW - 3) / 2;
  const rightX = M + colW + 3;
  const rowH = 6.2;
  const headH = 6;

  const earnRows: Array<[string, number, boolean]> = [
    ["Basic Salary", Number(data.baseSalary ?? 0), false],
  ];
  if (lopDays > 0) {
    earnRows.push([`Less: Loss of Pay (${lopDays} d)`, -Number(data.lopDeduction ?? 0), true]);
  }
  for (const a of data.allowancesBreakdown ?? []) {
    earnRows.push([a.name, Number(a.amount ?? 0), false]);
  }
  if (has(extraAmt)) {
    earnRows.push([data.extraNote?.trim() ? `Additional: ${data.extraNote.trim()}` : "Additional Payment", extraAmt, false]);
  }

  const dedRows: Array<[string, number, boolean]> = [
    ...(data.deductionsBreakdown ?? []).map(
      (d): [string, number, boolean] => [d.name, Number(d.amount ?? 0), true],
    ),
    ...(has(advance) ? [["Advance Recovered", advance, true] as [string, number, boolean]] : []),
  ];

  // ── Fit the two columns into what is actually left of the sheet ───────────
  // A payslip is a single page by contract, but the number of pay components is
  // whatever the employee's structure holds. Measure the fixed tail first, then
  // tighten the row pitch, and only if that is still not enough fold the surplus
  // into one summarised line so the column totals stay honest.
  const SAFE_BOTTOM = PH - 15;
  const wordLines = p.wrap(amountInWords(netTotal), CW - 32, 7);
  const wordsH = 4 + wordLines.length * 3.6;
  const pfEmpr = Number(data.pfEmployer ?? 0);
  const esiEmpr = Number(data.esiEmployer ?? 0);
  const hasCtc = has(pfEmpr) || has(esiEmpr);
  const sigH = 17;
  const tailH = 4 + 12.5 + wordsH + 3.5 + (hasCtc ? 11 + 3.5 : 0) + sigH;
  const capacity = SAFE_BOTTOM - y - tailH - headH - 8.5;

  let pitch = rowH;
  let bodyRows = Math.max(earnRows.length, dedRows.length, 3);
  if (bodyRows * pitch > capacity) pitch = Math.max(4.2, capacity / bodyRows);
  if (bodyRows * pitch > capacity) {
    const maxRows = Math.max(3, Math.floor(capacity / pitch));
    const fold = (rows: Array<[string, number, boolean]>, negative: boolean) => {
      if (rows.length <= maxRows) return;
      const kept = rows.slice(0, maxRows - 1);
      const rest = rows.slice(maxRows - 1);
      const total = rest.reduce((a, r) => a + r[1], 0);
      kept.push([`Other components (${rest.length})`, total, negative]);
      rows.length = 0;
      rows.push(...kept);
    };
    fold(earnRows, false);
    fold(dedRows, true);
    bodyRows = Math.max(earnRows.length, dedRows.length, 3);
  }
  const bodyH = bodyRows * pitch;
  // Type has to follow the pitch. At the tightest spacing a 7pt baseline sitting
  // 4.3 mm down overshoots its own row and prints over the totals band.
  const rowFs = pitch >= 5.4 ? 7 : 6.2;
  const baseline = Math.min(4.3, pitch - 0.8);

  const column = (
    x: number, title: string, rows: Array<[string, number, boolean]>,
    totalLabel: string, totalValue: number, totalFg: [number, number, number],
  ) => {
    p.fill(x, y, colW, headH, NAVY);
    p.txt(title, x + 3, y + 4.2, { size: 6.6, bold: true, color: WHITE });
    p.box(x, y, colW, headH + bodyH + 8.5, BORDER, 0.25);

    let ry = y + headH;
    if (rows.length === 0) {
      p.txt("None", x + 3, ry + 4.2, { size: 7, color: MGRAY });
    }
    rows.forEach(([label, amount, negative], i) => {
      if (i % 2 === 1) p.fill(x + 0.3, ry + 0.3, colW - 0.6, pitch, LGRAY);
      // Shrink-then-ellipsize rather than taking the first wrapped line: a long
      // component name is then visibly cut instead of silently losing its tail.
      const l = p.fit(label, colW - 32, rowFs);
      p.txt(l.text, x + 3, ry + baseline, { size: l.size });
      p.txt(
        `${amount < 0 ? "- " : ""}${inr(Math.abs(amount))}`,
        x + colW - 3, ry + baseline,
        { size: rowFs, align: "right", color: negative ? RED : [20, 20, 20] },
      );
      ry += pitch;
    });

    const ty = y + headH + bodyH;
    p.fill(x + 0.3, ty, colW - 0.6, 8.2, [237, 241, 247]);
    p.line(x, ty, x + colW, ty, BORDER, 0.3);
    p.txt(totalLabel, x + 3, ty + 5.6, { size: 7.4, bold: true });
    p.txt(inr(totalValue), x + colW - 3, ty + 5.6,
      { size: 8, bold: true, align: "right", color: totalFg });
  };

  column(M, "EARNINGS", earnRows, "Gross Earnings", grossEarnings, GREEN);
  column(rightX, "DEDUCTIONS", dedRows, "Total Deductions", totalDeductions, RED);
  y += headH + bodyH + 8.5 + 4;

  // ── Net pay + amount in words ─────────────────────────────────────────────
  p.fill(M, y, CW, 12.5, NAVY);
  p.txt("NET PAY", M + 4, y + 8.2, { size: 10.5, bold: true, color: WHITE });
  p.txt(inr(netTotal), PW - M - 4, y + 8.4,
    { size: 13, bold: true, color: [168, 232, 190], align: "right" });
  y += 12.5;

  p.fill(M, y, CW, wordsH, [244, 247, 251]);
  p.box(M, y, CW, wordsH, BORDER, 0.2);
  p.txt("In words:", M + 4, y + 4.4, { size: 6.4, color: MGRAY });
  wordLines.forEach((l, i) => {
    p.txt(l, M + 22, y + 4.4 + i * 3.6, { size: 7, bold: true, color: [45, 55, 72] });
  });
  y += wordsH + 3.5;

  // ── Employer contributions, disclosure only ───────────────────────────────
  if (hasCtc) {
    const ctcH = 11;
    p.box(M, y, CW, ctcH, BORDER, 0.25);
    p.txt("EMPLOYER CONTRIBUTIONS (not deducted from salary)", M + 3, y + 4,
      { size: 5.8, color: MGRAY });
    const bits = [
      has(pfEmpr) ? `Provident Fund ${inr(pfEmpr)}` : "",
      has(esiEmpr) ? `ESI ${inr(esiEmpr)}` : "",
    ].filter(Boolean).join("     ");
    p.txt(bits, M + 3, y + 8.6, { size: 7.2 });
    p.txt(`Cost to Company: ${inr(grossEarnings + pfEmpr + esiEmpr)}`, PW - M - 3, y + 8.6,
      { size: 7.2, bold: true, align: "right" });
    y += ctcH + 3.5;
  }

  // ── Signatures, immediately after the summary ─────────────────────────────
  p.box(M, y, colW, sigH, BORDER, 0.25);
  p.box(rightX, y, colW, sigH, BORDER, 0.25);
  p.txt("Employee's Signature", M + 3, y + sigH - 2.5, { size: 6, color: MGRAY });
  p.txt(`For ${cName}`, rightX + 3, y + 4.5, { size: 7, bold: true });
  p.txt("Authorised Signatory", rightX + colW - 3, y + sigH - 2.5,
    { size: 6, color: MGRAY, align: "right" });

  stampFooters(doc, `Computer-generated payslip \u2022 ${cName} \u2022 ${val(data.monthLabel)}`);

  return Buffer.from(doc.output("arraybuffer"));
}
