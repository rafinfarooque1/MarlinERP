/**
 * Payslip PDF generator — jsPDF, A4 portrait.
 * Accepts pre-assembled payroll data posted from the frontend.
 */
import { jsPDF } from "jspdf";

export interface PayslipBreakdownItem { name: string; amount: number }

export interface PayslipPdfInput {
  cs?: { companyName?: string };
  employeeName: string;
  branchName: string;
  monthLabel: string;
  workingDays: number;
  presentDays: number;
  lopDays: number;
  lopDeduction: number;
  baseSalary: number;
  allowancesBreakdown: PayslipBreakdownItem[];
  deductionsBreakdown: PayslipBreakdownItem[];
  grossPay: number;
  deductions: number;
  netPay: number;
  isPaid: boolean;
  paidDate?: string | null;
}

type RGB = [number, number, number];

export function generatePayslipPdf(data: PayslipPdfInput): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });

  const M  = 15;
  const PW = 210;
  const PH = 297;
  const CW = PW - M*2;

  // ── Helpers ──────────────────────────────────────────────────────────────
  const txt = (s: string, x: number, y: number, opts?: {
    size?: number; bold?: boolean; align?: "left"|"center"|"right"; color?: RGB;
  }) => {
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 8);
    const c = opts?.color ?? [0, 0, 0];
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(s, x, y, { align: opts?.align ?? "left" });
  };
  const fillRect = (x: number, y: number, w: number, h: number, rgb: RGB) => {
    doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(x, y, w, h, "F");
  };
  const outlineRect = (x: number, y: number, w: number, h: number, lw = 0.3) => {
    doc.setDrawColor(0); doc.setLineWidth(lw); doc.rect(x, y, w, h);
  };
  const hline = (x1: number, y: number, x2: number, lw = 0.2) => {
    doc.setDrawColor(200); doc.setLineWidth(lw); doc.line(x1, y, x2, y);
  };
  const vline = (x: number, y1: number, y2: number) => {
    doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(x, y1, x, y2);
  };

  const money = (n: number) => `Rs. ${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  let y = M;
  const cName = data.cs?.companyName || "Company";

  // ── Header band ──────────────────────────────────────────────────────────
  fillRect(M, y, CW, 14, [25, 72, 140]);
  txt(cName, PW/2, y+8, { size: 13, bold: true, align: "center", color: [255,255,255] });
  txt("PAYSLIP", PW/2, y+12.5, { size: 7.5, align: "center", color: [180,215,255] });
  y += 16;

  // ── Pay period + status ───────────────────────────────────────────────────
  outlineRect(M, y, CW, 11);
  txt("Pay Period", M+2, y+4.5, { size: 6.5, color: [100,100,100] });
  txt(data.monthLabel || "—", M+2, y+9, { size: 10, bold: true });

  const isPaid = !!data.isPaid;
  const paidBg: RGB = isPaid ? [220,252,231] : [254,243,199];
  const paidFg: RGB = isPaid ? [22,163,74] : [180,100,0];
  fillRect(M+CW-36, y+1.5, 34, 8, paidBg);
  outlineRect(M+CW-36, y+1.5, 34, 8, 0.2);
  txt(isPaid ? "PAID" : "PENDING", M+CW-19, y+7.5, { size: 9, bold: true, align: "center", color: paidFg });
  y += 13;

  // ── Employee details ──────────────────────────────────────────────────────
  outlineRect(M, y, CW, 20);
  vline(M+CW/2, y, y+20);
  txt("Employee", M+3, y+5, { size: 6.5, color: [100,100,100] });
  txt(data.employeeName || "—", M+3, y+11, { size: 9.5, bold: true });
  txt(`Branch: ${data.branchName || "—"}`, M+3, y+17, { size: 7.5, color: [80,80,80] });

  txt("Attendance", M+CW/2+3, y+5, { size: 6.5, color: [100,100,100] });
  txt(`${data.workingDays ?? "—"} working days / ${data.presentDays ?? "—"} present`, M+CW/2+3, y+11, { size: 8, bold: true });
  if ((data.lopDays || 0) > 0) {
    txt(`LOP: ${data.lopDays} days  (Deduction: ${money(data.lopDeduction)})`, M+CW/2+3, y+17, { size: 7.5, color: [200,50,50] });
  }
  y += 22;

  // ── Section helper ────────────────────────────────────────────────────────
  const sectionHeader = (label: string, fg: RGB) => {
    fillRect(M, y, CW, 7, [240,244,255]);
    outlineRect(M, y, CW, 7, 0.2);
    txt(label, M+3, y+5, { size: 7.5, bold: true, color: fg });
    y += 7;
  };

  const tableRow = (label: string, amount: number, idx: number, amtColor?: RGB) => {
    if (idx % 2 === 1) fillRect(M, y, CW, 7.5, [248,250,254]);
    doc.setDrawColor(220); doc.setLineWidth(0.2); doc.rect(M, y, CW, 7.5);
    txt(label, M+3, y+5.5, { size: 7.5 });
    txt(money(amount), M+CW-3, y+5.5, { size: 7.5, bold: true, align: "right", color: amtColor ?? [0,0,0] });
    y += 7.5;
  };

  const totalRow = (label: string, amount: number, bg: RGB, fg: RGB) => {
    fillRect(M, y, CW, 9, bg);
    outlineRect(M, y, CW, 9, 0.4);
    txt(label, M+3, y+6, { size: 8.5, bold: true });
    txt(money(amount), M+CW-3, y+6, { size: 8.5, bold: true, align: "right", color: fg });
    y += 11;
  };

  // ── Earnings ──────────────────────────────────────────────────────────────
  sectionHeader("EARNINGS", [30, 80, 160]);
  const earningRows: Array<[string, number, RGB]> = [
    ["Basic Salary", data.baseSalary, [0,0,0]],
    ...((data.lopDays || 0) > 0 ? [["Less: LOP Deduction", data.lopDeduction, [200,50,50]] as [string, number, RGB]] : []),
    ...(data.allowancesBreakdown || []).map((a: PayslipBreakdownItem) => [a.name, a.amount, [0,0,0]] as [string, number, RGB]),
  ];
  earningRows.forEach(([label, amt, fg], i) => tableRow(label, amt, i, fg));
  totalRow("Gross Pay", data.grossPay, [220,245,235], [22,163,74]);

  // ── Deductions ────────────────────────────────────────────────────────────
  sectionHeader("DEDUCTIONS", [170, 30, 30]);
  const dedRows = data.deductionsBreakdown || [];
  if (dedRows.length === 0) {
    fillRect(M, y, CW, 7.5, [250,250,250]);
    outlineRect(M, y, CW, 7.5, 0.2);
    txt("No deductions", M+3, y+5.5, { size: 7.5, color: [140,140,140] });
    y += 9;
  } else {
    dedRows.forEach((d: PayslipBreakdownItem, i: number) => tableRow(d.name, d.amount, i, [200,50,50]));
  }
  totalRow("Total Deductions", data.deductions, [255,238,238], [200,50,50]);

  // ── Net Pay ───────────────────────────────────────────────────────────────
  fillRect(M, y, CW, 16, [25, 72, 140]);
  outlineRect(M, y, CW, 16, 0.5);
  txt("NET PAY", M+4, y+10, { size: 13, bold: true, color: [255,255,255] });
  txt(money(data.netPay), M+CW-4, y+10, { size: 14, bold: true, align: "right", color: [160,230,160] });
  y += 18;

  if (isPaid && data.paidDate) {
    try {
      const d = new Date(data.paidDate);
      txt(`Paid on: ${d.toLocaleDateString("en-IN")}`, M, y, { size: 7, color: [80,80,80] });
    } catch { /* ignore */ }
    y += 6;
  }

  // ── Signature footer ──────────────────────────────────────────────────────
  const footY = PH - 36;
  hline(M, footY, M+CW, 0.5);
  outlineRect(M, footY, CW/2, 22);
  outlineRect(M+CW/2, footY, CW/2, 22);
  txt("Employee's Signature", M+3, footY+5, { size: 6, color: [100,100,100] });
  txt(cName, M+CW-3, footY+5, { size: 7.5, bold: true, align: "right" });
  txt("Authorised Signatory", M+CW-3, footY+19, { size: 6, align: "right", color: [100,100,100] });

  return Buffer.from(doc.output("arraybuffer"));
}
